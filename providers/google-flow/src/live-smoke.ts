import { randomUUID } from "node:crypto";
import path from "node:path";
import { CdpBrowserGateway } from "@flowforge/browser";
import { GenerationProviderError } from "@flowforge/core";
import { GoogleFlowProvider } from "./index.js";

/** Script-authored failure text; safe to print because it never contains page content. */
class DiagnosticError extends Error {}

const CONFIRMATION = "I_UNDERSTAND_THIS_GENERATES_MEDIA";

async function main(): Promise<void> {
  if (
    process.env.FLOWFORGE_LIVE_SMOKE !== "1" ||
    process.env.FLOWFORGE_CONFIRM_LIVE_GENERATION !== CONFIRMATION
  ) {
    throw new DiagnosticError(
      "Live smoke is opt-in only. Set FLOWFORGE_LIVE_SMOKE=1 and " +
        `FLOWFORGE_CONFIRM_LIVE_GENERATION=${CONFIRMATION} after authorizing a manually authenticated Flow session.`,
    );
  }

  const endpoint = process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
  const rootDir = path.resolve(process.env.FLOWFORGE_GOOGLE_FLOW_DATA_DIR ?? ".flowforge/google-flow");
  const browser = new CdpBrowserGateway({ endpoint });
  const provider = new GoogleFlowProvider(browser, { rootDir });

  try {
    const session = await provider.connect();
    console.log(`[FlowForge] Google Flow session status: ${session.status}`);
    if (session.status !== "READY") {
      throw new DiagnosticError(`Manual session is not ready (${session.reasonCode ?? session.status}); no generation was submitted.`);
    }

    const providerRequestKey = process.env.FLOWFORGE_LIVE_SMOKE_REQUEST_KEY ?? `live-smoke-${randomUUID()}`;
    console.log(`[FlowForge] Non-secret provider request key for same-attempt resume: ${providerRequestKey}`);
    const request = {
      projectId: "live-smoke-project",
      sceneId: "live-smoke-scene",
      sceneVersionId: "live-smoke-scene-version",
      prompt: "A blue ceramic cube on a plain white tabletop, soft studio lighting.",
      references: [],
      provider: "google-flow",
      parameters: { mode: "image", outputCount: 1 },
      jobId: `live-smoke-job-${randomUUID()}`,
      logicalIdempotencyKey: `live-smoke-logical-${randomUUID()}`,
      providerRequestKey,
      attemptNumber: 1,
    };
    const existing = await provider.findGeneration(providerRequestKey, request);
    const handle = existing ?? await provider.createGeneration(request);
    console.log(`[FlowForge] Image request state: ${handle.status}; waiting for a visible correlated result.`);

    let completed = false;
    for (let poll = 0; poll < 90; poll += 1) {
      const snapshot = await provider.getGenerationStatus(handle.providerJobId, request);
      console.log(`[FlowForge] Visible status: ${snapshot.status}`);
      if (snapshot.status === "SUCCEEDED") {
        completed = true;
        break;
      }
      if (snapshot.status === "FAILED" || snapshot.status === "CANCELLED") {
        throw new DiagnosticError(`Flow reported terminal status ${snapshot.status}; no retry was attempted.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!completed) {
      throw new DiagnosticError("Live smoke timed out; the provider request was not resubmitted. Resume it with the same provider data directory and request key if appropriate.");
    }

    const [artifact] = await provider.downloadResult(handle.providerJobId, request);
    console.log(`[FlowForge] Opt-in smoke result downloaded: ${artifact?.fileName ?? "unknown file"}`);
  } finally {
    await provider.disconnect();
  }
}

main().catch((error: unknown) => {
  // Only FlowForge's own typed provider code/message are printed: never page text, prompts, or browser detail.
  if (error instanceof GenerationProviderError) {
    console.error(
      `[FlowForge] Opt-in Google Flow live smoke did not complete: ${error.code} — ${error.message} ` +
        `(retryable=${error.retryable}, submissionUnknown=${error.submissionUnknown}).`,
    );
  } else if (error instanceof DiagnosticError) {
    console.error(`[FlowForge] Opt-in Google Flow live smoke did not complete: ${error.message}`);
  } else {
    console.error("[FlowForge] Opt-in Google Flow live smoke did not complete. Error detail was omitted to protect browser data.");
  }
  process.exitCode = 1;
});
