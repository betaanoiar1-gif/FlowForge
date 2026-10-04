import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GenerationProviderError } from "@flowforge/core";
import type {
  GenerationProviderRequest,
  ProviderAdapter,
  ProviderArtifact,
  ProviderCapabilities,
  ProviderGenerationHandle,
  ProviderGenerationSnapshot,
} from "@flowforge/core";
import { BrowserGatewayError } from "@flowforge/browser";
import type { BrowserGateway, PageObservation, SemanticQuery } from "@flowforge/browser";

export type GoogleFlowSessionStatus =
  | "DISCONNECTED"
  | "NO_PAGE"
  | "NOT_FLOW"
  | "AUTH_REQUIRED"
  | "BLOCKED"
  | "BUSY"
  | "READY"
  | "UI_CHANGED";

export interface GoogleFlowSessionInspection {
  provider: "google-flow";
  sessionId?: string;
  browserState: string;
  status: GoogleFlowSessionStatus;
  /** Query strings and fragments are deliberately omitted. */
  activeUrl?: string;
  reasonCode?: string;
}

export interface GoogleFlowProviderOptions {
  /** Local, access-controlled directory for non-secret recovery manifests and downloads. */
  rootDir?: string;
}

export const GOOGLE_FLOW_ERROR_CODES = Object.freeze({
  BROWSER_UNAVAILABLE: "FLOW_BROWSER_UNAVAILABLE",
  RECOVERY_STORAGE_UNAVAILABLE: "FLOW_RECOVERY_STORAGE_UNAVAILABLE",
  SESSION_NOT_READY: "FLOW_SESSION_NOT_READY",
  TIMEOUT: "FLOW_TIMEOUT",
  AUTH_REQUIRED: "FLOW_AUTH_REQUIRED",
  ACCESS_BLOCKED: "FLOW_ACCESS_BLOCKED",
  UI_CHANGED: "FLOW_UI_CHANGED",
  UNSUPPORTED_REQUEST: "FLOW_UNSUPPORTED_REQUEST",
  PROMPT_FILL_FAILED: "FLOW_PROMPT_FILL_FAILED",
  SUBMISSION_UNKNOWN: "FLOW_SUBMISSION_UNKNOWN",
  CORRELATION_AMBIGUOUS: "FLOW_CORRELATION_AMBIGUOUS",
  GENERATION_FAILED: "FLOW_GENERATION_FAILED",
  RESULT_NOT_READY: "FLOW_RESULT_NOT_READY",
  DOWNLOAD_FAILED: "FLOW_DOWNLOAD_FAILED",
  DOWNLOAD_TIMEOUT: "FLOW_DOWNLOAD_TIMEOUT",
  GENERATION_NOT_FOUND: "FLOW_GENERATION_NOT_FOUND",
  CANCEL_UNAVAILABLE: "FLOW_CANCEL_UNAVAILABLE",
} as const);

type GoogleFlowErrorCode = (typeof GOOGLE_FLOW_ERROR_CODES)[keyof typeof GOOGLE_FLOW_ERROR_CODES];
type ManifestState = "PREPARED" | "SUBMITTING" | "NOT_SUBMITTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
type CorrelationMethod = "visible-prompt-and-new-media" | "visible-prompt-and-active-generation";

interface RecoveryBaseline {
  promptOccurrences: number;
  mediaSignatures: string[];
  busy: boolean;
  sessionId?: string;
}

interface FlowManifest {
  schemaVersion: 1;
  providerRequestKey: string;
  providerJobId: string;
  attemptNumber: number;
  /** One-way request fingerprint; prompt text remains in the existing durable job record. */
  promptHash: string;
  state: ManifestState;
  dispatchConfirmed: boolean;
  baseline: RecoveryBaseline;
  correlationMethod?: CorrelationMethod;
  correlationMediaSignature?: string;
  failureMessage?: string;
  resultPath?: string;
  fileName?: string;
  createdAt: string;
  updatedAt: string;
}

interface FlowContext {
  inspection: GoogleFlowSessionInspection;
  observation?: PageObservation;
  mode?: "image" | "video";
}

interface Correlation {
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  method: CorrelationMethod;
  mediaSignature?: string;
  error?: string;
}

const FLOW_HOME_URL = "https://labs.google/fx/tools/flow";
const PROMPT_QUERY: SemanticQuery = {
  role: "textbox",
  contenteditable: true,
  visible: true,
  enabled: true,
};
const GENERATE_QUERY: SemanticQuery = {
  name: /^(?:Generate|Construction begins)$/i,
  visible: true,
  enabled: true,
};
const GENERATE_CONTROL_QUERY: SemanticQuery = {
  ...GENERATE_QUERY,
  enabled: undefined,
  includeDisabled: true,
};
const DOWNLOAD_QUERY: SemanticQuery = {
  name: /^Download(?: image)?$/i,
  visible: true,
  enabled: true,
};
const MORE_QUERY: SemanticQuery = {
  name: /^More(?: options)?$/i,
  visible: true,
  enabled: true,
};
const AUTH_TEXT = /sign in to continue|sign in with google|choose an account|authentication required|you need to sign in/i;
const BLOCKED_TEXT = /captcha|unusual traffic|suspicious activity|verify (?:that )?you(?:'| a)?re human|verify it's you|security challenge|access denied|account restricted|not available in your (?:country|region)/i;
const BUSY_TEXT = /\b(?:generating|generation in progress|processing generation|queued for generation)\b/i;
const FAILURE_TEXT = /(?:could not|couldn't|failed to|unable to) generate|generation failed|generation error/i;
const MANIFEST_STATES = new Set<ManifestState>([
  "PREPARED", "SUBMITTING", "NOT_SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED",
]);
const CORRELATION_METHODS = new Set<CorrelationMethod>([
  "visible-prompt-and-new-media", "visible-prompt-and-active-generation",
]);

/** Exported so an operator surface can validate a request against declared capabilities without
 * constructing a provider (and therefore without touching the browser) when it only enqueues. */
export const GOOGLE_FLOW_CAPABILITIES: ProviderCapabilities = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: false,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});

/**
 * Google Flow integration through visible UI only. Its provider-specific selectors are
 * deliberately centralized here; the browser package contains no Flow assumptions.
 */
/** Exported separately from the class so a caller can identify the provider without a browser. */
export const GOOGLE_FLOW_PROVIDER_ID = "google-flow";

export class GoogleFlowProvider implements ProviderAdapter {
  readonly id = GOOGLE_FLOW_PROVIDER_ID;
  readonly capabilities = GOOGLE_FLOW_CAPABILITIES;
  readonly rootDir: string;
  private readonly recordsDir: string;
  private readonly downloadsDir: string;
  /** Kept only in memory so clearPrompt can remove text inserted by this instance, never arbitrary text. */
  private preparedPrompt?: string;

  constructor(private readonly browser: BrowserGateway, options: GoogleFlowProviderOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(process.cwd(), ".flowforge", "google-flow"));
    this.recordsDir = path.join(this.rootDir, "records");
    this.downloadsDir = path.join(this.rootDir, "downloads");
  }

  /** Connects to, but never authenticates or reads authentication material from, Chrome. */
  async connect(): Promise<GoogleFlowSessionInspection> {
    try {
      await this.browser.connect();
    } catch {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.BROWSER_UNAVAILABLE,
        "Could not attach to the configured user-authorized browser session.",
        true,
        true,
      );
    }
    return this.inspectSession();
  }

  async disconnect(): Promise<void> {
    await this.browser.disconnect();
  }

  async selectTab(tabId: string): Promise<GoogleFlowSessionInspection> {
    await this.browser.selectTab(tabId);
    return this.inspectSession();
  }

  /** Opens Google's public Flow page; any sign-in remains a manual user action. */
  async openFlow(newTab = false): Promise<GoogleFlowSessionInspection> {
    try {
      await this.browser.open(FLOW_HOME_URL, { newTab });
    } catch {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.BROWSER_UNAVAILABLE,
        "Could not open the public Google Flow page in the attached browser.",
        true,
        true,
      );
    }
    return this.inspectSession();
  }

  async inspectSession(): Promise<GoogleFlowSessionInspection> {
    return (await this.inspectFlowContext()).inspection;
  }

  /** Legacy diagnostic shape retained for the opt-in prompt-only smoke script. */
  async inspectState(): Promise<Record<string, unknown>> {
    const inspection = await this.inspectSession();
    return {
      provider: this.id,
      sessionId: inspection.sessionId,
      browser: inspection.browserState,
      status: inspection.status,
      activeUrl: inspection.activeUrl,
      reasonCode: inspection.reasonCode,
    };
  }

  async preparePrompt(prompt: string): Promise<void> {
    const session = await this.inspectFlowContext();
    if (session.inspection.status !== "READY") {
      throw sessionError(session.inspection);
    }
    const current = await this.browser.resolve(PROMPT_QUERY);
    if (!current.matched || !current.element) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The visible Flow prompt editor is not unique.", true, true);
    }
    const result = await this.browser.fill(PROMPT_QUERY, prompt, 5_000, { expectedBeforeValue: "" });
    if (!result.matched || !result.verified) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED,
        "The Flow prompt could not be filled and read back safely.",
        true,
        false,
      );
    }
    this.preparedPrompt = prompt;
  }

  async clearPrompt(): Promise<void> {
    const expectedPrompt = this.preparedPrompt;
    if (expectedPrompt === undefined) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED,
        "This provider instance has no verified prompt to clear; existing text was left unchanged.",
        false,
        false,
      );
    }
    const current = await this.browser.resolve(PROMPT_QUERY);
    if (!current.matched || !current.element) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The visible Flow prompt editor is not unique.", true, true);
    }
    const result = await this.browser.fill(
      PROMPT_QUERY,
      "",
      5_000,
      { expectedBeforeValue: expectedPrompt },
    );
    if (!result.matched || !result.verified) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED, "The Flow prompt could not be cleared safely.", false, false);
    }
    this.preparedPrompt = undefined;
  }

  async discoverGenerate(): Promise<Awaited<ReturnType<BrowserGateway["resolve"]>>> {
    return this.browser.resolve(GENERATE_QUERY);
  }

  /** Explicit UI action kept for manual diagnostics; no queue path uses this helper directly. */
  async clickGenerate(timeoutMs = 2_000) {
    return this.browser.click(GENERATE_QUERY, timeoutMs);
  }

  async findGeneration(
    providerRequestKey: string,
    request?: GenerationProviderRequest,
  ): Promise<ProviderGenerationHandle | null> {
    const manifest = await this.readManifestByRequestKey(providerRequestKey);
    if (!manifest) return null;
    if (request) assertRequestMatchesManifest(manifest, providerRequestKey, request);
    if (manifest.state === "NOT_SUBMITTED") return null;
    if (manifest.state === "SUCCEEDED") {
      return { providerJobId: manifest.providerJobId, status: "SUCCEEDED" };
    }
    if (manifest.state === "FAILED") {
      return { providerJobId: manifest.providerJobId, status: "FAILED" };
    }
    if (manifest.state === "CANCELLED") {
      return { providerJobId: manifest.providerJobId, status: "CANCELLED" };
    }
    assertRequestMatchesManifest(manifest, providerRequestKey, request);

    const correlation = await this.observeCorrelation(manifest, request!);
    if (correlation.status === "SUCCEEDED") await this.updateManifest(manifest, {
      state: "SUCCEEDED",
      correlationMethod: correlation.method,
      correlationMediaSignature: correlation.mediaSignature,
    });
    else if (correlation.status === "FAILED") {
      await this.updateManifest(manifest, {
        state: "FAILED",
        correlationMethod: correlation.method,
        failureMessage: correlation.error ?? "Google Flow visibly reported a generation failure.",
      });
    } else {
      await this.updateManifest(manifest, { state: "RUNNING", correlationMethod: correlation.method });
    }
    return { providerJobId: manifest.providerJobId, status: correlation.status };
  }

  async createGeneration(request: GenerationProviderRequest): Promise<ProviderGenerationHandle> {
    validateRequest(request);
    let existing = await this.readManifestByRequestKey(request.providerRequestKey);
    if (existing) assertRequestMatchesManifest(existing, request.providerRequestKey, request);
    if (existing && existing.state !== "NOT_SUBMITTED") {
      const recovered = await this.findGeneration(request.providerRequestKey, request);
      if (recovered) return recovered;
      // A prepared/submitting record is deliberately not treated as proof of no submission.
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
        "A durable Flow submission record exists but no safe result correlation is visible; no new Generate action was sent.",
        true,
        true,
      );
    }

    const context = await this.inspectFlowContext();
    if (context.inspection.status !== "READY" || !context.observation) throw sessionError(context.inspection);
    if (context.mode !== "image") {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST,
        "This adapter supports only a visibly selected Image workflow; select Image manually before retrying.",
        false,
        false,
      );
    }

    let promptMatch: Awaited<ReturnType<BrowserGateway["resolve"]>>;
    try {
      promptMatch = await this.browser.resolve(PROMPT_QUERY);
    } catch {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The visible Flow prompt editor could not be inspected safely.", true, true);
    }
    if (!promptMatch.matched || !promptMatch.element) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The visible Flow prompt editor is not unique.", true, true);
    }
    const providerJobId = providerJobIdFor(request.providerRequestKey);
    const now = new Date().toISOString();
    const baseline: RecoveryBaseline = {
      promptOccurrences: countOccurrences(context.observation.visibleText, request.prompt),
      mediaSignatures: mediaSignatures(context.observation),
      busy: BUSY_TEXT.test(context.observation.visibleText),
      sessionId: this.browser.sessionId,
    };
    const manifest: FlowManifest = {
      schemaVersion: 1,
      providerRequestKey: request.providerRequestKey,
      providerJobId,
      attemptNumber: request.attemptNumber,
      promptHash: hashPrompt(request.prompt),
      state: "PREPARED",
      dispatchConfirmed: false,
      baseline,
      createdAt: now,
      updatedAt: now,
    };

    await this.ensureDirectories();
    if (existing?.state === "NOT_SUBMITTED") {
      try {
        await this.writeManifest(manifest);
      } catch {
        throw providerError(
          GOOGLE_FLOW_ERROR_CODES.RECOVERY_STORAGE_UNAVAILABLE,
          "Could not prepare the same Flow attempt locally; Generate was not clicked.",
          true,
          false,
        );
      }
    } else {
      try {
        await this.writeInitialManifest(manifest);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw providerError(
            GOOGLE_FLOW_ERROR_CODES.RECOVERY_STORAGE_UNAVAILABLE,
            "Could not persist the local Flow recovery record before submission; Generate was not clicked.",
            true,
            false,
          );
        }
        existing = await this.readManifestByRequestKey(request.providerRequestKey);
        if (!existing || existing.state === "NOT_SUBMITTED") {
          throw providerError(
            GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
            "A concurrent Flow recovery record could not be resolved safely; Generate was not clicked by this worker.",
            true,
            true,
          );
        }
        const recovered = await this.findGeneration(request.providerRequestKey, request);
        if (recovered) return recovered;
        throw providerError(
          GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
          "A concurrent Flow submission may be in progress; no second Generate action was sent.",
          true,
          true,
        );
      }
    }

    let fill: Awaited<ReturnType<BrowserGateway["fill"]>>;
    try {
      fill = await this.browser.fill(
        PROMPT_QUERY,
        request.prompt,
        5_000,
        { expectedBeforeValue: "" },
      );
    } catch {
      await this.updateManifest(manifest, { state: "NOT_SUBMITTED" });
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED,
        "The visible Flow prompt could not be filled; no Generate click was sent.",
        true,
        false,
      );
    }
    if (!fill.matched || !fill.verified) {
      await this.updateManifest(manifest, { state: "NOT_SUBMITTED" });
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED,
        "The visible Flow prompt could not be filled and verified; no Generate click was sent.",
        true,
        false,
      );
    }

    let generateTarget: Awaited<ReturnType<BrowserGateway["resolve"]>>;
    try {
      generateTarget = await this.browser.resolve(GENERATE_QUERY);
    } catch {
      await this.updateManifest(manifest, { state: "NOT_SUBMITTED" });
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The enabled Generate control could not be inspected; no click was sent.", true, false);
    }
    if (!generateTarget.matched) {
      await this.updateManifest(manifest, { state: "NOT_SUBMITTED" });
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.UI_CHANGED,
        "The enabled Generate control was not unique after prompt verification; no click was sent.",
        true,
        false,
      );
    }

    await this.updateManifest(manifest, { state: "SUBMITTING" });
    let click: Awaited<ReturnType<BrowserGateway["click"]>>;
    try {
      click = await this.browser.click(GENERATE_QUERY, 10_000);
    } catch {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
        "The Generate browser action ended without a reliable dispatch result; the persisted submission will be inspected before any retry.",
        true,
        true,
      );
    }
    if (!click.matched) {
      await this.updateManifest(manifest, { state: "NOT_SUBMITTED" });
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.UI_CHANGED,
        "The Generate control ceased to be unique before dispatch; no click was sent.",
        true,
        false,
      );
    }
    if (!click.dispatched) {
      throw providerError(
        click.timedOut ? GOOGLE_FLOW_ERROR_CODES.TIMEOUT : GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
        click.timedOut
          ? "The Generate click timed out before dispatch could be confirmed; the existing attempt will be inspected before any retry."
          : "The Generate action may have been dispatched, but the browser could not confirm it; the same attempt is retained and will not be resubmitted.",
        true,
        true,
      );
    }

    await this.updateManifest(manifest, { state: "RUNNING", dispatchConfirmed: true });
    if (!click.verified) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.TIMEOUT,
        "Generate was dispatched but no visible state change was confirmed before timeout; the same attempt will be inspected before any retry.",
        true,
        true,
      );
    }
    return { providerJobId, status: "RUNNING" };
  }

  async getGenerationStatus(
    providerJobId: string,
    request?: GenerationProviderRequest,
  ): Promise<ProviderGenerationSnapshot> {
    let manifest = await this.readManifestByProviderJobId(providerJobId);
    if (!manifest) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.GENERATION_NOT_FOUND,
        "No local Flow recovery record exists for this provider job ID.",
        false,
        true,
      );
    }
    if (request) assertRequestMatchesManifest(manifest, manifest.providerRequestKey, request);
    if (manifest.state === "SUCCEEDED" || manifest.state === "FAILED" || manifest.state === "CANCELLED") {
      return snapshotFromManifest(manifest);
    }
    // A terminal local record needs no page inspection; deciding live state requires the matching request.
    assertRequestMatchesManifest(manifest, manifest.providerRequestKey, request);

    const correlation = await this.observeCorrelation(manifest, request!);
    if (correlation.status === "SUCCEEDED") {
      manifest = await this.updateManifest(manifest, {
        state: "SUCCEEDED",
        correlationMethod: correlation.method,
        correlationMediaSignature: correlation.mediaSignature,
      });
    } else if (correlation.status === "FAILED") {
      manifest = await this.updateManifest(manifest, {
        state: "FAILED",
        correlationMethod: correlation.method,
        failureMessage: correlation.error ?? "Google Flow visibly reported a generation failure.",
      });
    } else {
      manifest = await this.updateManifest(manifest, { state: "RUNNING", correlationMethod: correlation.method });
    }
    return snapshotFromManifest(manifest);
  }

  async downloadResult(
    providerJobId: string,
    request?: GenerationProviderRequest,
  ): Promise<ProviderArtifact[]> {
    const manifest = await this.readManifestByProviderJobId(providerJobId);
    if (!manifest) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.GENERATION_NOT_FOUND, "No local Flow recovery record exists for this provider job ID.", false, true);
    }
    const status = await this.getGenerationStatus(providerJobId, request);
    if (status.status !== "SUCCEEDED") {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.RESULT_NOT_READY,
        "A uniquely correlated completed Flow image is not visible yet; no asset was downloaded.",
        true,
        true,
      );
    }

    const refreshed = await this.readManifestByProviderJobId(providerJobId);
    if (!refreshed) throw providerError(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, "Flow recovery state disappeared during download.", true, true);
    if (refreshed.resultPath && await isNonEmptyFile(refreshed.resultPath)) {
      return [this.toArtifact(refreshed)];
    }
    assertRequestMatchesManifest(refreshed, refreshed.providerRequestKey, request);
    const mediaTarget = await this.verifyVisibleResultCorrelation(refreshed, request!);
    let hovered = false;
    try {
      hovered = await this.browser.hover(mediaTarget, 2_000);
    } catch {
      hovered = false;
    }
    if (!hovered) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED,
        "The uniquely correlated Flow media element could not be hovered; no Download action was sent.",
        true,
        true,
      );
    }

    let downloadTarget: Awaited<ReturnType<BrowserGateway["resolve"]>>;
    try {
      downloadTarget = await this.browser.resolve(DOWNLOAD_QUERY);
      if (!downloadTarget.matched && downloadTarget.count === 0) {
        const more = await this.browser.resolve(MORE_QUERY);
        if (more.matched) {
          const opened = await this.browser.click(MORE_QUERY, 2_000);
          if (!opened.dispatched) {
            throw providerError(
              GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED,
              "The visible result menu could not be opened safely; the generation will not be repeated.",
              true,
              true,
            );
          }
          downloadTarget = await this.browser.resolve(DOWNLOAD_QUERY);
        }
      }
    } catch (error) {
      if (error instanceof GenerationProviderError) throw error;
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED,
        "The visible Flow download controls could not be inspected safely; the generation will not be repeated.",
        true,
        true,
      );
    }
    if (!downloadTarget.matched) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED,
        "A unique visible Download control for the correlated Flow result was not found.",
        true,
        true,
      );
    }

    try {
      await this.ensureDirectories();
      const downloaded = await this.browser.download(DOWNLOAD_QUERY, this.downloadsDir, 30_000);
      const resolvedPath = path.resolve(downloaded.path);
      if (!isPathInside(this.rootDir, resolvedPath) || !(await isNonEmptyFile(resolvedPath))) {
        throw new Error("Browser download did not produce a non-empty file in the provider data directory.");
      }
      const stored = await this.updateManifest(refreshed, {
        resultPath: resolvedPath,
        fileName: safeFileName(downloaded.fileName),
      });
      return [this.toArtifact(stored)];
    } catch (error) {
      const timedOut = error instanceof BrowserGatewayError && error.timedOut;
      throw providerError(
        timedOut ? GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_TIMEOUT : GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED,
        timedOut
          ? "The correlated Flow result download timed out; the same result will be retried without regenerating."
          : "The visible Flow result could not be downloaded; the same provider result will be retried without regenerating.",
        true,
        true,
      );
    }
  }

  async cancelGeneration(providerJobId: string): Promise<void> {
    const manifest = await this.readManifestByProviderJobId(providerJobId);
    if (!manifest || manifest.state === "CANCELLED" || manifest.state === "FAILED" || manifest.state === "SUCCEEDED") return;
    if (manifest.state === "NOT_SUBMITTED" || manifest.state === "PREPARED") {
      await this.updateManifest(manifest, { state: "CANCELLED" });
      return;
    }

    // The visible UI does not expose a tested per-attempt cancellation workflow. A generic
    // Stop control could target another user's generation, so local cancellation must not click it.
    throw providerError(
      GOOGLE_FLOW_ERROR_CODES.CANCEL_UNAVAILABLE,
      "The local job can be cancelled, but this adapter will not stop a remote Flow generation without a tested per-attempt visible correlation workflow.",
      false,
      true,
    );
  }

  private async inspectFlowContext(): Promise<FlowContext> {
    let browserState: string;
    try {
      browserState = await this.browser.state();
      // Reattach only to the configured CDP endpoint. This never performs sign-in or reads auth data.
      if (browserState === "DISCONNECTED") {
        await this.browser.connect();
        browserState = await this.browser.state();
      }
    } catch {
      return this.contextResult("DISCONNECTED", "BROWSER_STATE_UNAVAILABLE");
    }
    if (browserState === "DISCONNECTED") return this.contextResult("DISCONNECTED", "BROWSER_DISCONNECTED", browserState);
    if (browserState === "PAGE_NOT_FOUND") return this.contextResult("NO_PAGE", "NO_OPEN_PAGE", browserState);

    let observation: PageObservation;
    try {
      observation = await this.browser.observe();
    } catch {
      return this.contextResult("UI_CHANGED", "PAGE_OBSERVATION_FAILED", browserState);
    }
    const activeUrl = sanitizeUrl(observation.url);
    const sessionId = this.browser.sessionId;
    const inspectionBase = { provider: this.id as "google-flow", sessionId, browserState, activeUrl };
    const text = observation.visibleText;
    let url: URL | null = null;
    try {
      url = new URL(observation.url);
    } catch {
      // Not a valid web URL; classify it as outside Flow below.
    }
    if (BLOCKED_TEXT.test(text)) {
      return { inspection: { ...inspectionBase, status: "BLOCKED", reasonCode: "VISIBLE_ACCESS_OR_SECURITY_BLOCK" }, observation };
    }
    if ((url?.hostname.toLowerCase() === "accounts.google.com") || AUTH_TEXT.test(text)) {
      return { inspection: { ...inspectionBase, status: "AUTH_REQUIRED", reasonCode: "MANUAL_GOOGLE_AUTH_REQUIRED" }, observation };
    }
    if (!url || !isGoogleFlowUrl(url)) {
      return { inspection: { ...inspectionBase, status: "NOT_FLOW", reasonCode: "ACTIVE_PAGE_NOT_GOOGLE_FLOW" }, observation };
    }

    const busy = BUSY_TEXT.test(text);
    if (busy) return { inspection: { ...inspectionBase, status: "BUSY", reasonCode: "VISIBLE_GENERATION_ACTIVITY" }, observation };

    try {
      const [prompt, generate] = await Promise.all([
        this.browser.resolve(PROMPT_QUERY),
        this.browser.resolve(GENERATE_CONTROL_QUERY),
      ]);
      const mode = selectedMode(observation);
      if (prompt.matched && generate.matched && mode) {
        return { inspection: { ...inspectionBase, status: "READY" }, observation, mode };
      }
    } catch {
      // A changed or inaccessible UI is never treated as ready.
    }
    return { inspection: { ...inspectionBase, status: "UI_CHANGED", reasonCode: "EXPECTED_VISIBLE_CONTROLS_NOT_UNIQUE" }, observation };
  }

  private contextResult(status: GoogleFlowSessionStatus, reasonCode: string, browserState = "UNKNOWN"): FlowContext {
    return {
      inspection: {
        provider: this.id,
        sessionId: this.browser.sessionId,
        browserState,
        status,
        reasonCode,
      },
    };
  }

  private async observeCorrelation(
    manifest: FlowManifest,
    request: GenerationProviderRequest,
  ): Promise<Correlation> {
    const context = await this.inspectFlowContext();
    if (context.inspection.status === "BLOCKED") {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.ACCESS_BLOCKED, "Google Flow is showing an access/security block; manual user action is required.", true, true);
    }
    if (context.inspection.status === "AUTH_REQUIRED") {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.AUTH_REQUIRED, "Google authentication is required in the visible browser; authenticate manually and resume the same attempt.", true, true);
    }
    if (context.inspection.status === "UI_CHANGED") {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, "The Flow UI changed while a generation was pending; the same attempt is retained without resubmission.", true, true);
    }
    if (!context.observation || !isReadyOrBusy(context.inspection.status)) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, "The authorized Flow page is unavailable or changed; the prior submission is retained without resubmission.", true, true);
    }
    if (manifest.baseline.sessionId && context.inspection.sessionId !== manifest.baseline.sessionId) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, "The attached browser session differs from the one that started this attempt; result correlation stopped.", true, true);
    }

    const observation = context.observation;
    const promptDelta = countOccurrences(observation.visibleText, request.prompt) - manifest.baseline.promptOccurrences;
    const currentMedia = mediaCandidates(observation);
    const baselineMedia = new Set(manifest.baseline.mediaSignatures);
    const newMedia = currentMedia.filter((candidate) => !baselineMedia.has(candidate.signature));
    const visiblyBusy = BUSY_TEXT.test(observation.visibleText);
    const visibleFailure = FAILURE_TEXT.test(observation.visibleText);

    if (promptDelta === 1 && newMedia.length === 1 && newMedia[0]?.query) {
      return {
        status: "SUCCEEDED",
        method: "visible-prompt-and-new-media",
        mediaSignature: newMedia[0].signature,
      };
    }
    if (promptDelta === 1 && newMedia.length === 0 && visiblyBusy && !manifest.baseline.busy) {
      return { status: "RUNNING", method: "visible-prompt-and-active-generation" };
    }
    if (promptDelta === 1 && newMedia.length === 0 && visibleFailure && !manifest.baseline.busy) {
      return {
        status: "FAILED",
        method: "visible-prompt-and-active-generation",
        error: "Google Flow visibly reported that this correlated generation failed.",
      };
    }

    throw providerError(
      GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS,
      "The visible Flow page does not show exactly one new generation correlated to this attempt; no result was accepted or downloaded.",
      true,
      true,
    );
  }

  private async verifyVisibleResultCorrelation(
    manifest: FlowManifest,
    request: GenerationProviderRequest,
  ): Promise<SemanticQuery> {
    const context = await this.inspectFlowContext();
    if (!context.observation || !isReadyOrBusy(context.inspection.status)) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, "The Flow page is unavailable; the downloaded result could not be correlated.", true, true);
    }
    if (manifest.baseline.sessionId && context.inspection.sessionId !== manifest.baseline.sessionId) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, "The active browser session differs from the one that produced this result.", true, true);
    }
    const promptDelta = countOccurrences(context.observation.visibleText, request.prompt) - manifest.baseline.promptOccurrences;
    const baselineMedia = new Set(manifest.baseline.mediaSignatures);
    const newMedia = mediaCandidates(context.observation).filter((candidate) => !baselineMedia.has(candidate.signature));
    if (
      promptDelta !== 1 ||
      newMedia.length !== 1 ||
      !newMedia[0]?.query ||
      !manifest.correlationMediaSignature ||
      newMedia[0].signature !== manifest.correlationMediaSignature
    ) {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS,
        "The current visible Flow result no longer uniquely matches this job and attempt; no Download action was sent.",
        true,
        true,
      );
    }
    return newMedia[0]!.query!;
  }

  private async readManifestByRequestKey(requestKey: string): Promise<FlowManifest | null> {
    const providerJobId = providerJobIdFor(requestKey);
    return this.readManifest(path.join(this.recordsDir, `${providerJobId}.json`), requestKey, providerJobId);
  }

  private async readManifestByProviderJobId(providerJobId: string): Promise<FlowManifest | null> {
    if (!/^flow-[a-f0-9]{64}$/.test(providerJobId)) return null;
    return this.readManifest(path.join(this.recordsDir, `${providerJobId}.json`), undefined, providerJobId);
  }

  private async readManifest(filePath: string, expectedKey?: string, expectedId?: string): Promise<FlowManifest | null> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as FlowManifest;
      if (
        parsed.schemaVersion !== 1 ||
        typeof parsed.providerRequestKey !== "string" ||
        typeof parsed.providerJobId !== "string" ||
        parsed.providerJobId !== expectedId ||
        parsed.providerJobId !== providerJobIdFor(parsed.providerRequestKey) ||
        (expectedKey !== undefined && parsed.providerRequestKey !== expectedKey) ||
        !/^[a-f0-9]{64}$/.test(parsed.promptHash) ||
        !MANIFEST_STATES.has(parsed.state) ||
        typeof parsed.dispatchConfirmed !== "boolean" ||
        !Number.isSafeInteger(parsed.attemptNumber) || parsed.attemptNumber < 1 ||
        typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string" ||
        !Array.isArray(parsed.baseline?.mediaSignatures) ||
        !parsed.baseline.mediaSignatures.every((signature) => typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature)) ||
        !Number.isSafeInteger(parsed.baseline?.promptOccurrences) || parsed.baseline.promptOccurrences < 0 ||
        typeof parsed.baseline.busy !== "boolean" ||
        (parsed.baseline.sessionId !== undefined && typeof parsed.baseline.sessionId !== "string") ||
        (parsed.correlationMethod !== undefined && !CORRELATION_METHODS.has(parsed.correlationMethod)) ||
        (parsed.correlationMediaSignature !== undefined && !/^[a-f0-9]{64}$/.test(parsed.correlationMediaSignature)) ||
        (parsed.failureMessage !== undefined && typeof parsed.failureMessage !== "string") ||
        (parsed.resultPath !== undefined && typeof parsed.resultPath !== "string") ||
        (parsed.fileName !== undefined && typeof parsed.fileName !== "string") ||
        (parsed.resultPath === undefined) !== (parsed.fileName === undefined)
      ) {
        throw new Error("Invalid Flow recovery record.");
      }
      if (parsed.resultPath && !isPathInside(this.rootDir, path.resolve(parsed.resultPath))) {
        throw new Error("Flow recovery result path escapes the provider directory.");
      }
      return parsed;
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof GenerationProviderError) throw error;
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN,
        "A local Flow recovery record is unreadable; its submission outcome cannot be assumed.",
        true,
        true,
      );
    }
  }

  private async ensureDirectories(): Promise<void> {
    try {
      await mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
      await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 });
    } catch {
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.RECOVERY_STORAGE_UNAVAILABLE,
        "The local Google Flow recovery/download directory is unavailable.",
        true,
        false,
      );
    }
  }

  private async writeInitialManifest(manifest: FlowManifest): Promise<void> {
    await this.ensureDirectories();
    const destination = path.join(this.recordsDir, `${manifest.providerJobId}.json`);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await link(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async writeManifest(manifest: FlowManifest): Promise<void> {
    await this.ensureDirectories();
    const destination = path.join(this.recordsDir, `${manifest.providerJobId}.json`);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async updateManifest(manifest: FlowManifest, patch: Partial<FlowManifest>): Promise<FlowManifest> {
    const updated: FlowManifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
    try {
      await this.writeManifest(updated);
    } catch {
      const submissionUnknown = Boolean(
        manifest.dispatchConfirmed ||
        patch.dispatchConfirmed ||
        manifest.state === "SUBMITTING" ||
        manifest.state === "RUNNING" ||
        patch.state === "SUBMITTING" ||
        patch.state === "RUNNING" ||
        patch.state === "SUCCEEDED" ||
        patch.state === "FAILED"
      );
      throw providerError(
        GOOGLE_FLOW_ERROR_CODES.RECOVERY_STORAGE_UNAVAILABLE,
        "Could not durably update the local Flow recovery record.",
        true,
        submissionUnknown,
      );
    }
    return updated;
  }

  private toArtifact(manifest: FlowManifest): ProviderArtifact {
    if (!manifest.resultPath || !manifest.fileName) {
      throw providerError(GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED, "The correlated Flow result has not been downloaded yet.", true, true);
    }
    return {
      sourcePath: manifest.resultPath,
      fileName: manifest.fileName,
      outputIndex: 0,
      mimeType: imageMimeType(manifest.fileName),
    };
  }
}

/** Existing import name remains available while new code uses the provider name. */
export { GoogleFlowProvider as GoogleFlowAdapter };

function assertRequestMatchesManifest(
  manifest: FlowManifest,
  providerRequestKey: string,
  request: GenerationProviderRequest | undefined,
): asserts request is GenerationProviderRequest {
  if (
    !request ||
    request.provider !== "google-flow" ||
    request.providerRequestKey !== providerRequestKey ||
    request.attemptNumber !== manifest.attemptNumber ||
    hashPrompt(request.prompt) !== manifest.promptHash
  ) {
    throw providerError(
      GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS,
      "The provider request needed for visible-result correlation is missing or does not match the durable recovery record.",
      true,
      true,
    );
  }
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function providerError(
  code: GoogleFlowErrorCode,
  message: string,
  retryable: boolean,
  submissionUnknown: boolean,
): GenerationProviderError {
  return new GenerationProviderError({ message, code, retryable, submissionUnknown });
}

function sessionError(inspection: GoogleFlowSessionInspection): GenerationProviderError {
  if (inspection.status === "UI_CHANGED") {
    return providerError(
      GOOGLE_FLOW_ERROR_CODES.UI_CHANGED,
      "The visible Google Flow controls or selected mode no longer match the tested workflow; no submission was attempted.",
      true,
      true,
    );
  }
  if (inspection.status === "AUTH_REQUIRED") {
    return providerError(GOOGLE_FLOW_ERROR_CODES.AUTH_REQUIRED, "Sign in to Google Flow manually in the attached browser, then resume the same job attempt.", true, true);
  }
  if (inspection.status === "BLOCKED") {
    return providerError(GOOGLE_FLOW_ERROR_CODES.ACCESS_BLOCKED, "Google Flow is showing an access/security challenge; stop and resolve it manually.", false, true);
  }
  return providerError(
    GOOGLE_FLOW_ERROR_CODES.SESSION_NOT_READY,
    `Google Flow session is not ready (${inspection.reasonCode ?? inspection.status}); no submission was attempted.`,
    true,
    true,
  );
}

function snapshotFromManifest(manifest: FlowManifest): ProviderGenerationSnapshot {
  if (manifest.state === "FAILED") {
    return {
      providerJobId: manifest.providerJobId,
      status: "FAILED",
      error: manifest.failureMessage ?? "Google Flow reported a correlated generation failure.",
      errorCode: GOOGLE_FLOW_ERROR_CODES.GENERATION_FAILED,
      retryable: false,
    };
  }
  if (manifest.state === "CANCELLED") return { providerJobId: manifest.providerJobId, status: "CANCELLED" };
  if (manifest.state === "SUCCEEDED") return { providerJobId: manifest.providerJobId, status: "SUCCEEDED" };
  return { providerJobId: manifest.providerJobId, status: "RUNNING" };
}

function validateRequest(request: GenerationProviderRequest): void {
  if (request.provider !== "google-flow") {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "The request is not addressed to the Google Flow provider.", false, false);
  }
  if (!request.providerRequestKey.trim()) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "A stable provider request key is required.", false, false);
  }
  if (!request.prompt.trim()) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "A non-empty prompt is required.", false, false);
  }
  if (request.references?.length) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "Reference images are not enabled in the tested single-image workflow.", false, false);
  }
  const parameters = request.parameters ?? {};
  const requestedModes = [parameters.mode, parameters.mediaType, parameters.generationType].filter((value) => value !== undefined);
  if (requestedModes.some((value) => typeof value !== "string" || !/^image$/i.test(value))) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "Only one image output is implemented; video and other generation modes are not supported.", false, false);
  }
  if (parameters.outputCount !== undefined && parameters.outputCount !== 1) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "Only a single Flow output per provider request is supported.", false, false);
  }
  const supportedKeys = new Set(["mode", "mediaType", "generationType", "outputCount"]);
  if (Object.keys(parameters).some((key) => !supportedKeys.has(key))) {
    throw providerError(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, "The request contains Flow settings that are not verified by this adapter.", false, false);
  }
}

function isGoogleFlowUrl(url: URL): boolean {
  return url.protocol === "https:" &&
    url.hostname.toLowerCase() === "labs.google" &&
    /^\/fx\/tools\/flow(?:\/|$)/.test(url.pathname);
}

function sanitizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function selectedMode(observation: PageObservation): "image" | "video" | undefined {
  const selected = observation.elements.filter((element) => {
    if (element.selected !== true) return false;
    const label = `${element.accessibleName} ${element.text}`.toLowerCase();
    return /\bimages?\b|\bvideos?\b/.test(label);
  });
  if (selected.length !== 1) return undefined;
  const label = `${selected[0]!.accessibleName} ${selected[0]!.text}`.toLowerCase();
  if (/\bimages?\b/.test(label)) return "image";
  if (/\bvideos?\b/.test(label)) return "video";
  return undefined;
}

function countOccurrences(value: string, prompt: string): number {
  const normalizedValue = normalizeVisibleText(value).toLocaleLowerCase();
  const normalizedPrompt = normalizeVisibleText(prompt).toLocaleLowerCase();
  if (!normalizedPrompt) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = normalizedValue.indexOf(normalizedPrompt, offset)) !== -1) {
    count += 1;
    offset += normalizedPrompt.length;
  }
  return count;
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mediaSignatures(observation: PageObservation): string[] {
  return mediaCandidates(observation).map((candidate) => candidate.signature);
}

function mediaCandidates(observation: PageObservation): Array<{ signature: string; query?: SemanticQuery }> {
  return observation.elements
    .filter((element) => element.tagName !== "video" && (element.role === "img" || element.tagName === "img"))
    .map((element) => {
      const role = "img";
      const name = element.accessibleName.trim() || element.text.trim();
      const signature = createHash("sha256")
        .update(`${element.tagName}\0${role}\0${element.accessibleName}\0${element.text}`)
        .digest("hex");
      return {
        signature,
        query: name ? { role, name, exact: true, visible: true, enabled: true } : undefined,
      };
    });
}

function providerJobIdFor(requestKey: string): string {
  return `flow-${createHash("sha256").update(requestKey).digest("hex")}`;
}

function isReadyOrBusy(status: GoogleFlowSessionStatus): boolean {
  return status === "READY" || status === "BUSY";
}

function imageMimeType(fileName: string): string | undefined {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    default: return undefined;
  }
}

function safeFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!baseName || baseName === "." || baseName === "..") return `flow-result-${randomUUID()}.bin`;
  return baseName.slice(0, 180);
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const file = await stat(filePath);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
