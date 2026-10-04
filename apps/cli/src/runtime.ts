import { mkdir } from "node:fs/promises";
import path from "node:path";
import { FileSystemAssetStore } from "@flowforge/assets";
import type { GenerationProvider } from "@flowforge/core";
import type { MockArtifactMode, MockProviderMode } from "@flowforge/provider-mock";
import { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import { SqliteJobRepository } from "@flowforge/storage";
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

export interface OpenedApplication {
  app: FlowForgeApplication;
  globals: ResolvedGlobals;
  dataDir: string;
  assetRoot: string;
  providerId: string;
  executionEnabled: boolean;
  close: () => Promise<void>;
}

/**
 * CLI composition root: it opens the durable repository, queue, provider, and worker exactly the
 * way the vertical slice does, then hands them to the application services. No orchestration,
 * retry, storage, or browser logic lives in this file beyond construction and teardown.
 */
export async function openApplication(
  globals: ResolvedGlobals,
  options: { execution: boolean; workerId?: string } = { execution: true },
): Promise<OpenedApplication> {
  const dataDir = path.resolve(globals.dataDir);
  await mkdir(dataDir, { recursive: true });
  const assetRoot = path.join(dataDir, "assets");
  const repository = new SqliteJobRepository(path.join(dataDir, "flowforge.sqlite"));
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
  });

  return {
    app,
    globals,
    dataDir,
    assetRoot,
    providerId: descriptor.id,
    executionEnabled: worker !== undefined,
    close: async () => {
      await teardown();
      repository.close();
    },
  };
}
