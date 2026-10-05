import { mkdir } from "node:fs/promises";
import path from "node:path";
import { FileSystemAssetStore } from "@flowforge/assets";
import type { AIPlanner, GenerationProvider } from "@flowforge/core";
import type { MockArtifactMode, MockProviderMode } from "@flowforge/provider-mock";
import { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";
import { ApplicationError, createApplication, type FlowForgeApplication, type ProviderDescriptor } from "@flowforge/services";
import { isSet, optionalNumber, optionalString, UsageError, type ParsedArgs } from "./args.js";

/** Endpoint for operator messages: scheme and host only, so credentials or tokens in a URL are never printed. */
function describeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "unparseable endpoint";
  }
}

export const MOCK_MODES: readonly MockProviderMode[] = Object.freeze([
  "SUCCESS",
  "TRANSIENT_FAILURE",
  "PERMANENT_FAILURE",
  "TIMEOUT",
  "DUPLICATE_RESULT",
]);
export const ARTIFACT_MODES: readonly MockArtifactMode[] = Object.freeze(["VALID_PNG", "INVALID_PNG"]);
export const PROVIDER_IDS = Object.freeze({ MOCK: "mock", GOOGLE_FLOW: "google-flow" });

/** Flags understood by every subcommand; they select the durable wiring, not the intent. */
export const GLOBAL_FLAGS = [
  "data-dir",
  "provider",
  "mode",
  "artifact",
  "cdp-endpoint",
  "lease-ms",
  "retry-delay-ms",
  "max-attempts",
  "json",
] as const;

export interface ResolvedGlobals {
  dataDir: string;
  provider: string;
  mode: MockProviderMode;
  artifact: MockArtifactMode;
  cdpEndpoint?: string;
  leaseMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  json: boolean;
}

export function resolveGlobals(args: ParsedArgs): ResolvedGlobals {
  const options = args.options;
  const mode = (optionalString(options, "mode") ?? "SUCCESS").toUpperCase();
  if (!MOCK_MODES.includes(mode as MockProviderMode)) {
    throw new UsageError(`--mode must be one of ${MOCK_MODES.join(", ")}.`, `Got: ${mode}`);
  }
  const artifact = (optionalString(options, "artifact") ?? "VALID_PNG").toUpperCase();
  if (!ARTIFACT_MODES.includes(artifact as MockArtifactMode)) {
    throw new UsageError(`--artifact must be one of ${ARTIFACT_MODES.join(", ")}.`, `Got: ${artifact}`);
  }
  const provider = optionalString(options, "provider") ?? PROVIDER_IDS.MOCK;
  if (provider !== PROVIDER_IDS.MOCK && provider !== PROVIDER_IDS.GOOGLE_FLOW) {
    throw new UsageError(`--provider must be "${PROVIDER_IDS.MOCK}" or "${PROVIDER_IDS.GOOGLE_FLOW}".`, `Got: ${provider}`);
  }
  for (const [name, value] of [
    ["lease-ms", optionalNumber(options, "lease-ms")],
    ["retry-delay-ms", optionalNumber(options, "retry-delay-ms")],
    ["max-attempts", optionalNumber(options, "max-attempts")],
  ] as const) {
    if (value !== undefined && value < 0) throw new UsageError(`--${name} must not be negative.`);
  }
  return {
    dataDir: optionalString(options, "data-dir") ?? path.resolve(".flowforge"),
    provider,
    mode: mode as MockProviderMode,
    artifact: artifact as MockArtifactMode,
    cdpEndpoint: optionalString(options, "cdp-endpoint") ?? process.env.FLOWFORGE_CDP_ENDPOINT,
    leaseMs: optionalNumber(options, "lease-ms") ?? 30_000,
    retryDelayMs: optionalNumber(options, "retry-delay-ms") ?? 0,
    maxAttempts: optionalNumber(options, "max-attempts") ?? 3,
    json: isSet(options, "json"),
  };
}

/**
 * The AI planner adapters this build can wire. The table is deliberately short: adding a vendor means
 * adding a package that implements the domain's `AIPlanner` port, not touching planning logic, and an
 * operator selects it here rather than by editing code.
 */
export const AI_ADAPTERS = Object.freeze(["openai-chat"] as const);
export type AiAdapterId = (typeof AI_ADAPTERS)[number];

/**
 * Selection of an AI planner adapter from the command line. Every field is *configuration*, and the
 * credential is only ever named: the flag carries the environment variable to read, never a key.
 */
export interface AiPlannerSelection {
  adapter: AiAdapterId;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export function resolveAiPlannerSelection(options: ParsedArgs["options"]): AiPlannerSelection {
  const adapter = optionalString(options, "ai-adapter") ?? "openai-chat";
  if (!(AI_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new UsageError(
      `--ai-adapter must be one of ${AI_ADAPTERS.join(", ")}.`,
      `An adapter is a package that implements FlowForge's AIPlanner port; ${adapter} is not installed.`,
    );
  }
  return {
    adapter: adapter as AiAdapterId,
    model: optionalString(options, "ai-model"),
    baseUrl: optionalString(options, "ai-base-url") ?? process.env.FLOWFORGE_AI_BASE_URL,
    apiKeyEnv: optionalString(options, "ai-key-env") ?? process.env.FLOWFORGE_AI_KEY_ENV,
  };
}

/**
 * Constructs the selected adapter. The package is imported only for a command that asked for AI planning,
 * so an unrelated invocation never loads a provider module, never reads an environment variable, and
 * cannot reach an endpoint. The constructed object is the domain port and nothing else: it has no
 * repository, queue, or browser to misuse.
 */
export async function createAiPlanner(
  selection: AiPlannerSelection,
): Promise<{ readonly aiPlanner: AIPlanner; readonly described: Record<string, unknown> }> {
  if (selection.adapter !== "openai-chat") {
    throw new UsageError(`Adapter ${selection.adapter} is not implemented in this build.`);
  }
  const flow = await import("@flowforge/provider-openai-chat");
  const planner = new flow.OpenAiChatPlanner({
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(selection.baseUrl === undefined ? {} : { baseUrl: selection.baseUrl }),
    ...(selection.apiKeyEnv === undefined ? {} : { apiKeyEnv: selection.apiKeyEnv }),
  });
  return { aiPlanner: planner, described: planner.describe() };
}

export interface OpenedApplication {
  app: FlowForgeApplication;
  globals: ResolvedGlobals;
  dataDir: string;
  assetRoot: string;
  providerId: string;
  executionEnabled: boolean;
  /** What the AI planning adapter was configured as, when one was wired. Identity only, never a key. */
  aiPlanner?: Record<string, unknown>;
  close: () => Promise<void>;
}

/**
 * CLI composition root: it opens the durable repository, queue, provider, and worker exactly the
 * way the vertical slice does, then hands them to the application services. No orchestration,
 * retry, storage, or browser logic lives in this file beyond construction and teardown.
 */
export async function openApplication(
  globals: ResolvedGlobals,
  options: { execution: boolean; workerId?: string; aiPlanner?: AIPlanner; describedAiPlanner?: Record<string, unknown> } = {
    execution: true,
  },
): Promise<OpenedApplication> {
  const dataDir = path.resolve(globals.dataDir);
  await mkdir(dataDir, { recursive: true });
  const assetRoot = path.join(dataDir, "assets");
  const repository = new SqliteJobRepository(path.join(dataDir, "flowforge.sqlite"));
  // Planning (Phase 4A) shares the repository's migrated connection instead of opening a second one.
  const planning = new SqlitePlanningRepository(repository);
  const queue = new SqliteJobQueue(repository);

  let descriptor: ProviderDescriptor;
  let provider: GenerationProvider | undefined;
  let teardown: () => Promise<void> = async () => {};
  if (globals.provider === PROVIDER_IDS.GOOGLE_FLOW) {
    const flow = await import("@flowforge/provider-google-flow");
    descriptor = { id: flow.GOOGLE_FLOW_PROVIDER_ID, capabilities: flow.GOOGLE_FLOW_CAPABILITIES };
    // The browser is only attached when this invocation actually drives work; reads and
    // enqueueing must never require a live session.
    if (options.execution) {
      const { CdpBrowserGateway } = await import("@flowforge/browser");
      const endpoint = globals.cdpEndpoint ?? "http://127.0.0.1:9222";
      const gateway = new CdpBrowserGateway({ endpoint });
      try {
        await gateway.connect();
      } catch (error) {
        throw new ApplicationError(
          "PROVIDER_SESSION_UNAVAILABLE",
          `Could not attach to the operator-owned browser session (${describeEndpoint(endpoint)}). Authenticate the browser and start the gateway first; FlowForge never logs in for you.`,
          {
            provider: descriptor.id,
            endpoint: describeEndpoint(endpoint),
            reason: error instanceof Error ? error.message.split("\n")[0] : String(error),
          },
        );
      }
      teardown = () => gateway.disconnect();
      provider = new flow.GoogleFlowProvider(gateway, { rootDir: path.join(dataDir, "google-flow") });
    }
  } else {
    const { MockGenerationProvider } = await import("@flowforge/provider-mock");
    const mock = new MockGenerationProvider({
      rootDir: path.join(dataDir, "mock-provider"),
      mode: globals.mode,
      artifact: globals.artifact,
      failAttempts: globals.mode === "TRANSIENT_FAILURE" ? 1 : 0,
    });
    descriptor = mock;
    provider = mock;
  }

  if (options.execution && !provider) {
    throw new Error(`Provider "${globals.provider}" cannot be executed in this invocation.`);
  }
  const worker =
    options.execution && provider
      ? new LocalQueueWorker(repository, queue, provider, new FileSystemAssetStore(assetRoot), {
          workerId: options.workerId ?? `flowforge-cli-${process.pid}`,
          leaseMs: globals.leaseMs,
          retryDelayMs: globals.retryDelayMs,
          maxRecoveries: 3,
        })
      : undefined;

  const app = createApplication(repository, {
    queue,
    providers: [descriptor],
    worker,
    workerProviderId: worker ? descriptor.id : undefined,
    defaultMaxAttempts: globals.maxAttempts,
    planning,
    aiPlanner: options.aiPlanner,
  });

  return {
    app,
    globals,
    dataDir,
    assetRoot,
    providerId: descriptor.id,
    executionEnabled: worker !== undefined,
    ...(options.describedAiPlanner === undefined ? {} : { aiPlanner: options.describedAiPlanner }),
    close: async () => {
      await teardown();
      repository.close();
    },
  };
}
