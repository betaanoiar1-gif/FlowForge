/**
 * Phase 6 boundary suite: the real Google Flow provider exercised through the existing
 * `BrowserGateway` contract with a fake gateway, never a live Flow session.
 *
 * The load-bearing assertions are the side-effect counters — `generateClicks`, `downloadCalls`,
 * `pollCalls` — because the rules this provider exists to enforce are "one Generate submission per
 * attempt", "download only a correlated result", and "observe instead of resubmitting". Error codes are
 * asserted as the operator-facing classification of those decisions, never as a substitute for them.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationProviderError } from "@flowforge/core";
import {
  GOOGLE_FLOW_CAPABILITIES,
  GOOGLE_FLOW_ERROR_CODES,
  GOOGLE_FLOW_PROVIDER_ID,
  GoogleFlowProvider,
} from "../dist/index.js";
import { completeGeneration, FakeFlowGateway, tinyPng } from "./support/fake-flow-gateway.mjs";

const PROMPT = "A quiet lighthouse at sunrise, viewed from the shore.";

/** Sentinels planted where the adapter could have leaked: URL query, page title, and prompt text. */
const SECRET_QUERY = "authuser=0&token=SECRET-QUERY-TOKEN";
const SECRET_TITLE = "SECRET-TITLE-Material";
const SECRET_MARKERS = ["SECRET-QUERY-TOKEN", "SECRET-TITLE-Material", PROMPT];

function request(providerRequestKey, overrides = {}) {
  return {
    projectId: "project-flow",
    sceneId: "scene-flow",
    sceneVersionId: "scene-version-flow",
    prompt: PROMPT,
    references: [],
    provider: "google-flow",
    parameters: { mode: "image", outputCount: 1 },
    metadata: {},
    jobId: "job-flow",
    logicalIdempotencyKey: "logical-flow",
    providerRequestKey,
    attemptNumber: 1,
    ...overrides,
  };
}

/** Every scenario carries leak-detecting page state, so the hygiene sweep needs no separate setup. */
function withSecrets(scenario) {
  const url = scenario.url ?? "https://labs.google/fx/tools/flow";
  return { title: SECRET_TITLE, ...scenario, url: `${url}?${SECRET_QUERY}` };
}

async function withFlow(scenario, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-boundary-"));
  const gateway = new FakeFlowGateway(withSecrets(scenario));
  await gateway.connect();
  const provider = new GoogleFlowProvider(gateway, { rootDir: directory });
  try {
    return await run({ provider, gateway, directory });
  } finally {
    await gateway.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

function rejectsFlow(code, extra = {}) {
  return (error) => {
    assert.ok(error instanceof GenerationProviderError, `expected a GenerationProviderError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value, `${key} classification`);
    return true;
  };
}

function clicks(gateway) {
  return gateway.generateClicks;
}

function pageOperations(gateway) {
  return gateway.operations.filter((operation) => operation !== "connect" && operation !== "disconnect");
}

// -------------------------------------------------------------------------------------------
// Session states that must stop the adapter before any side effect
// -------------------------------------------------------------------------------------------

test("an authenticated ready Flow page is reported as READY without reading editable contents", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const session = await provider.inspectSession();
    assert.equal(session.status, "READY");
    assert.equal(session.provider, "google-flow");
    assert.equal(session.activeUrl, "https://labs.google/fx/tools/flow");
    assert.equal(JSON.stringify(session).includes("SECRET"), false, "the query string is dropped from the report");
    assert.deepEqual(Object.keys(session).sort(), ["activeUrl", "browserState", "provider", "sessionId", "status"]);
    assert.equal("visibleText" in session, false);
    assert.equal(gateway.generateClicks, 0, "inspection never clicks");
    assert.equal(gateway.fillCalls, 0, "inspection never writes to the editor");
  });
});

test("manual authentication is reported as AUTH_REQUIRED, is not retried, and is never bypassed", async () => {
  await withFlow({ auth: true }, async ({ provider, gateway }) => {
    const session = await provider.inspectSession();
    assert.equal(session.status, "AUTH_REQUIRED");
    assert.equal(session.reasonCode, "MANUAL_GOOGLE_AUTH_REQUIRED");
    await assert.rejects(() => provider.createGeneration(request("flow-auth-required")), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.AUTH_REQUIRED, {
      retryable: false,
      submissionUnknown: false,
    }));
    assert.equal(gateway.generateClicks, 0);
    assert.equal(await provider.attemptState("flow-auth-required"), null, "a refused session leaves no submission record");
    assert.equal(gateway.operations.includes("fill"), false, "the adapter never signs in or writes on the user's behalf");
  });
});

test("a missing page or a dead transport is a retryable browser failure, not a provider failure", async () => {
  for (const scenario of [{ noPage: true }, { disconnected: true }]) {
    await withFlow(scenario, async ({ provider, gateway }) => {
      const inspection = await provider.inspectSession();
      assert.equal(inspection.status, scenario.noPage ? "NO_PAGE" : "DISCONNECTED");
      await assert.rejects(
        () => provider.createGeneration(request(`flow-transport-${scenario.noPage ? "page" : "socket"}`)),
        rejectsFlow(GOOGLE_FLOW_ERROR_CODES.BROWSER_UNAVAILABLE, { retryable: true, submissionUnknown: false }),
      );
      assert.equal(gateway.generateClicks, 0);
    });
  }
});

test("a security or access block stops the adapter with its own classification", async () => {
  await withFlow({ blocked: true }, async ({ provider, gateway }) => {
    assert.equal((await provider.inspectSession()).status, "BLOCKED");
    await assert.rejects(() => provider.createGeneration(request("flow-blocked")), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.ACCESS_BLOCKED, {
      retryable: false,
      submissionUnknown: false,
    }));
    assert.equal(gateway.generateClicks, 0);
    assert.equal(gateway.operations.filter((operation) => operation === "click").length, 0, "no control is clicked to answer a challenge");
  });
});

test("a generation already in flight is waited for instead of joined or replaced", async () => {
  await withFlow({ busy: true }, async ({ provider, gateway }) => {
    assert.equal((await provider.inspectSession()).status, "BUSY");
    await assert.rejects(() => provider.createGeneration(request("flow-busy")), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SESSION_NOT_READY, {
      retryable: true,
      submissionUnknown: false,
    }));
    assert.equal(gateway.generateClicks, 0, "a busy page never receives a second Generate action");
    assert.equal(gateway.fillCalls, 0, "the in-flight editor is not rewritten");
  });
});

test("editor, prompt-input, and generate-control absence are distinguishable failures", async () => {
  const cases = [
    { scenario: { promptEditor: "missing", generate: "missing", mode: null }, code: GOOGLE_FLOW_ERROR_CODES.EDITOR_NOT_FOUND },
    { scenario: { promptEditor: "missing" }, code: GOOGLE_FLOW_ERROR_CODES.PROMPT_INPUT_NOT_FOUND },
    { scenario: { generate: "missing" }, code: GOOGLE_FLOW_ERROR_CODES.GENERATE_CONTROL_NOT_FOUND },
    { scenario: { promptEditor: "ambiguous", generate: "ambiguous", mode: null }, code: GOOGLE_FLOW_ERROR_CODES.EDITOR_NOT_FOUND },
    { scenario: { mode: null }, code: GOOGLE_FLOW_ERROR_CODES.UI_CHANGED },
  ];
  const seenCodes = new Set();
  for (const { scenario, code } of cases) {
    await withFlow(scenario, async ({ provider, gateway }) => {
      assert.equal((await provider.inspectSession()).status, "UI_CHANGED");
      await assert.rejects(
        () => provider.createGeneration(request(`flow-absent-${code}`)),
        rejectsFlow(code, { retryable: false, submissionUnknown: false }),
      );
      assert.equal(gateway.generateClicks, 0);
      assert.equal(gateway.fillCalls, 0, "a page without its controls is never written to");
      seenCodes.add(code);
    });
  }
  // Four distinguishable answers from one inspection, instead of one generic "UI changed".
  assert.deepEqual(
    [...seenCodes].sort(),
    [
      GOOGLE_FLOW_ERROR_CODES.EDITOR_NOT_FOUND,
      GOOGLE_FLOW_ERROR_CODES.GENERATE_CONTROL_NOT_FOUND,
      GOOGLE_FLOW_ERROR_CODES.PROMPT_INPUT_NOT_FOUND,
      GOOGLE_FLOW_ERROR_CODES.UI_CHANGED,
    ].sort(),
  );
  assert.equal(new Set(cases.map((entry) => entry.code)).size, seenCodes.size, "one state maps to exactly one code");
});

test("a still-loading Flow page is waited for rather than submitted against", async () => {
  await withFlow({ readyState: "loading" }, async ({ provider, gateway }) => {
    assert.equal((await provider.inspectSession()).status, "PAGE_NOT_READY");
    await assert.rejects(
      () => provider.createGeneration(request("flow-loading")),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.PAGE_NOT_READY, { retryable: true, submissionUnknown: false }),
    );
    assert.equal(gateway.generateClicks, 0);

    // The same attempt succeeds once the document finishes: waiting consumed nothing.
    gateway.setPage({ readyState: "complete" });
    const handle = await provider.createGeneration(request("flow-loading"));
    assert.equal(handle.status, "RUNNING");
    assert.equal(gateway.generateClicks, 1);
  });
});

test("a disabled Generate control identifies the page but is never clicked", async () => {
  await withFlow({ generate: "disabled" }, async ({ provider, gateway }) => {
    assert.equal(
      (await provider.inspectSession()).status,
      "READY",
      "a disabled Generate control still identifies Flow, which is why submission re-checks it",
    );
    await assert.rejects(
      () => provider.createGeneration(request("flow-disabled-generate")),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.GENERATE_CONTROL_NOT_FOUND, { retryable: false, submissionUnknown: false }),
    );
    assert.equal(gateway.generateClicks, 0);
    const state = await provider.attemptState("flow-disabled-generate");
    assert.equal(state.phase, "NOT_SUBMITTED", "the record proves no submission, so a later retry stays safe");
  });
});

// -------------------------------------------------------------------------------------------
// Prompt integrity
// -------------------------------------------------------------------------------------------

test("an unverifiable prompt fails closed before the click", async () => {
  await withFlow({ echoPrompt: false }, async ({ provider, gateway }) => {
    await assert.rejects(
      () => provider.createGeneration(request("flow-prompt-mismatch")),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.PROMPT_NOT_VISIBLE, { retryable: false, submissionUnknown: false }),
    );
    assert.equal(gateway.generateClicks, 0, "a visible button is never, by itself, a reason to click Generate");
    assert.equal(gateway.fillCalls, 1, "the guarded fill happened, so the refusal is a real read-back failure");
    assert.equal((await provider.attemptState("flow-prompt-mismatch")).phase, "NOT_SUBMITTED");
  });
});

test("text already in the editor is preserved and stops the submission", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    gateway.prompt = "someone else's unfinished prompt";
    await assert.rejects(
      () => provider.createGeneration(request("flow-occupied-editor")),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED, { retryable: true, submissionUnknown: false }),
    );
    assert.equal(gateway.prompt, "someone else's unfinished prompt", "the adapter never overwrites user text");
    assert.equal(gateway.generateClicks, 0);
  });
});

test("an editor that changed between verification and submission stops the click", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const originalObserve = gateway.observe.bind(gateway);
    let observes = 0;
    // The prompt is present once during verification, then the page loses it before the click.
    gateway.observe = async () => {
      observes += 1;
      if (observes === 2) gateway.prompt = "";
      return originalObserve();
    };
    await assert.rejects(
      () => provider.createGeneration(request("flow-editor-drift")),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.PROMPT_NOT_VISIBLE, { retryable: false, submissionUnknown: false }),
    );
    assert.equal(gateway.generateClicks, 0);
    assert.equal((await provider.attemptState("flow-editor-drift")).phase, "NOT_SUBMITTED");
  });
});

// -------------------------------------------------------------------------------------------
// Submission, acceptance, and correlation
// -------------------------------------------------------------------------------------------

test("a successful submission performs exactly one Generate action and records acceptance before any result", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-submit-once");
    const handle = await provider.createGeneration(input);
    assert.equal(handle.status, "RUNNING");
    assert.equal(clicks(gateway), 1, "one attempt submits exactly once");
    assert.equal(gateway.pollCalls, 2, "readiness plus the pre-click prompt check, and nothing more");
    assert.match(handle.providerJobId, /^flow-[a-f0-9]{64}$/);

    const accepted = await provider.attemptState("flow-submit-once");
    assert.equal(accepted.phase, "SUBMISSION_ACCEPTED");
    assert.equal(accepted.dispatchConfirmed, true);
    assert.equal(accepted.hasCorrelatedMedia, false, "a dispatched click is never treated as a result");
    assert.equal(accepted.attemptNumber, 1);
    assert.equal(accepted.providerJobId, handle.providerJobId);

    completeGeneration(gateway);
    const snapshot = await provider.getGenerationStatus(handle.providerJobId, input);
    assert.equal(snapshot.status, "SUCCEEDED");
    const detected = await provider.attemptState("flow-submit-once");
    assert.equal(detected.phase, "RESULT_DETECTED");
    assert.equal(detected.correlationMethod, "visible-prompt-and-new-media");
    assert.equal(detected.hasDownloadedArtifact, false);

    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.equal(artifact.mimeType, "image/png");
    assert.equal(artifact.outputIndex, 0);
    assert.deepEqual(await readFile(artifact.sourcePath), tinyPng(), "the imported bytes are exactly the downloaded result");
    assert.equal(gateway.downloadCalls, 1);
    assert.equal(clicks(gateway), 1, "correlation and download never re-submit");
    assert.equal((await provider.attemptState("flow-submit-once")).phase, "RESULT_STORED");
  });
});

test("a repeated request for the same attempt is recovery, and never re-clicks or rewrites the editor", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-idempotent");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    const again = await provider.createGeneration(input);
    assert.equal(again.providerJobId, handle.providerJobId);
    assert.equal(again.status, "SUCCEEDED");
    assert.equal(clicks(gateway), 1);

    await provider.createGeneration(input);
    await provider.createGeneration(input);
    assert.equal(clicks(gateway), 1, "repeating a known submission is pure recovery");
    assert.equal(gateway.fillCalls, 1, "a recovered attempt never rewrites the editor");
  });
});

test("ambiguous correlation is refused, downloads nothing, and regenerates nothing", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-ambiguous-media");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway, { mediaCount: 2 });
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1, "an ambiguous page is never resolved by generating again");
    assert.equal(gateway.downloadCalls, 0, "nothing is downloaded while the result is ambiguous");
    const state = await provider.attemptState("flow-ambiguous-media");
    assert.equal(state.phase, "SUBMISSION_ACCEPTED", "the refusal stays visible in the recovery record");
    assert.equal(state.hasCorrelatedMedia, false);
  });
});

test("prompt evidence alone never becomes a result: media must appear as well", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-no-media");
    const handle = await provider.createGeneration(input);
    gateway.setPage({ busy: false, resultMedia: 0 });
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
  });
});

test("a second visible page claiming the same prompt is ambiguous, not a latest-result pick", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-double-echo");
    const handle = await provider.createGeneration(input);
    gateway.setPage({ busy: false, resultMedia: 1, downloadVisible: true });
    const originalVisible = Object.getOwnPropertyDescriptor(FakeFlowGateway.prototype, "visibleText");
    Object.defineProperty(gateway, "visibleText", {
      configurable: true,
      get() {
        return `${originalVisible.get.call(this)} ${PROMPT}`;
      },
    });
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
    assert.equal(gateway.downloadCalls, 0);
  });
});

test("a visibly reported generation failure is terminal for that request and is recovered, not repeated", async () => {
  await withFlow({ failureVisible: true }, async ({ provider, gateway }) => {
    const input = request("flow-visible-failure");
    const handle = await provider.createGeneration(input);
    gateway.setPage({ busy: false });
    const snapshot = await provider.getGenerationStatus(handle.providerJobId, input);
    assert.equal(snapshot.status, "FAILED");
    assert.equal(snapshot.errorCode, GOOGLE_FLOW_ERROR_CODES.GENERATION_FAILED);
    assert.equal(snapshot.retryable, false);
    assert.equal((await provider.attemptState("flow-visible-failure")).phase, "FAILED");
    assert.equal(clicks(gateway), 1);

    const recovered = await provider.createGeneration(input);
    assert.deepEqual(recovered, { providerJobId: handle.providerJobId, status: "FAILED" });
    assert.equal(clicks(gateway), 1, "the provider reports the terminal outcome instead of submitting again");
  });
});

// -------------------------------------------------------------------------------------------
// Timeout, recovery, and restart
// -------------------------------------------------------------------------------------------

test("a poll timeout after a confirmed click is observed again on the same attempt, never resubmitted", async () => {
  await withFlow({ clickResult: "unverified" }, async ({ provider, gateway }) => {
    const input = request("flow-poll-timeout");
    await assert.rejects(() => provider.createGeneration(input), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.TIMEOUT, {
      submissionUnknown: true,
    }));
    assert.equal(clicks(gateway), 1);
    const state = await provider.attemptState("flow-poll-timeout");
    assert.equal(state.phase, "SUBMISSION_ACCEPTED", "the click landed, so only observation may follow");

    completeGeneration(gateway);
    const snapshot = await provider.getGenerationStatus(state.providerJobId, input);
    assert.equal(snapshot.status, "SUCCEEDED");
    assert.equal(clicks(gateway), 1, "a poll timeout never becomes a second generation");
  });
});

test("a click whose dispatch could not be confirmed stays SUBMITTING and is never re-clicked", async () => {
  await withFlow({ clickResult: "unconfirmed-timeout" }, async ({ provider, gateway }) => {
    const input = request("flow-dispatch-unconfirmed");
    await assert.rejects(() => provider.createGeneration(input), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.TIMEOUT, {
      submissionUnknown: true,
    }));
    const state = await provider.attemptState("flow-dispatch-unconfirmed");
    assert.equal(state.phase, "SUBMITTING");
    assert.equal(state.dispatchConfirmed, false);
    assert.equal(clicks(gateway), 1);

    await assert.rejects(
      () => provider.createGeneration(input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1, "an unconfirmed dispatch is resolved by observing, not by clicking again");
    assert.equal(gateway.downloadCalls, 0);
  });
});

test("a browser-side click failure is uncertainty about the submission, not a licence to retry it", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-click-throws");
    gateway.fail("click");
    await assert.rejects(
      () => provider.createGeneration(input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 0, "the adapter did not click, yet it still refuses to assume the outcome");
    assert.equal((await provider.attemptState("flow-click-throws")).phase, "SUBMITTING");
    gateway.setPage({ failOps: [] });
    completeGeneration(gateway);
    const recovered = await provider.findGeneration(input.providerRequestKey, input);
    assert.equal(recovered.status, "SUCCEEDED", "the next pass finds the result the failed click did produce");
    assert.equal(clicks(gateway), 0);
  });
});

test("a control that disappears before dispatch is a proven non-submission and may be retried", async () => {
  await withFlow({ generate: "enabled" }, async ({ provider, gateway }) => {
    const input = request("flow-vanishing-control");
    const originalClick = gateway.click.bind(gateway);
    gateway.click = async (query, timeoutMs) => {
      gateway.setPage({ generate: "missing" });
      return originalClick(query, timeoutMs);
    };
    await assert.rejects(
      () => provider.createGeneration(input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_FAILED, { retryable: true, submissionUnknown: false }),
    );
    assert.equal(clicks(gateway), 0);
    assert.equal((await provider.attemptState("flow-vanishing-control")).phase, "NOT_SUBMITTED");
  });
});

test("a generation started by a previous process is recovered and completed by the new one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-restart-"));
  const gateway = new FakeFlowGateway(withSecrets({}));
  await gateway.connect();
  try {
    const input = request("flow-restart");
    const first = new GoogleFlowProvider(gateway, { rootDir: directory });
    const handle = await first.createGeneration(input);

    gateway.connected = false; // the browser itself restarted
    const second = new GoogleFlowProvider(gateway, { rootDir: directory });
    const recovered = await second.findGeneration(input.providerRequestKey, input);
    assert.equal(recovered.status, "RUNNING", "recovery reattaches and observes the same attempt");
    assert.equal(gateway.operations.filter((operation) => operation === "connect").length, 2, "reattachment only, never authentication");
    completeGeneration(gateway);
    assert.equal((await second.findGeneration(input.providerRequestKey, input)).status, "SUCCEEDED");
    assert.equal(clicks(gateway), 1);
    assert.equal((await second.attemptState("flow-restart")).providerJobId, handle.providerJobId);
    assert.equal((await second.attemptState("flow-restart")).phase, "RESULT_DETECTED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a recovery observation cannot be proven against a different browser session", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-session-drift");
    await provider.createGeneration(input);
    gateway.sessionId = "cdp-some-other-browser";
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1, "a different browser session is never accepted as the same evidence");
    assert.equal(gateway.downloadCalls, 0);
  });
});

test("a transport failure while observing a pending generation defers the same attempt", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-observe-failure");
    const handle = await provider.createGeneration(input);
    gateway.fail("observe");
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.UI_CHANGED, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
    gateway.setPage({ failOps: [] });
    completeGeneration(gateway);
    assert.equal((await provider.getGenerationStatus(handle.providerJobId, input)).status, "SUCCEEDED");
    assert.equal(clicks(gateway), 1, "an interrupted poll resumes; it does not resubmit");
  });
});

test("an attempt record that cannot be read is uncertainty, never permission to submit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-corrupt-record-"));
  const gateway = new FakeFlowGateway(withSecrets({}));
  await gateway.connect();
  try {
    const input = request("flow-corrupt-record");
    const provider = new GoogleFlowProvider(gateway, { rootDir: directory });
    const handle = await provider.createGeneration(input);
    const recordPath = path.join(directory, "records", `${handle.providerJobId}.json`);
    await writeFile(recordPath, "{ truncated write", "utf8");

    await assert.rejects(() => provider.findGeneration(input.providerRequestKey, input), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, {
      submissionUnknown: true,
    }));
    await assert.rejects(() => provider.createGeneration(input), rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, {
      submissionUnknown: true,
    }));
    assert.equal(clicks(gateway), 1);
    await assert.rejects(
      () => provider.attemptState(input.providerRequestKey),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.SUBMISSION_UNKNOWN, { submissionUnknown: true }),
      "an unreadable record is not a state report",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------
// Download and artifact handling
// -------------------------------------------------------------------------------------------

test("download waits for correlation, hovers the correlated media, and opens the menu only when needed", async () => {
  await withFlow({ downloadVisible: false, downloadNeedsMenu: true }, async ({ provider, gateway }) => {
    const input = request("flow-download-menu");
    const handle = await provider.createGeneration(input);

    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.RESULT_NOT_READY, { submissionUnknown: true }),
    );
    assert.equal(gateway.downloadCalls, 0, "an uncorrelated result is never downloaded");
    assert.equal(clicks(gateway), 1);

    completeGeneration(gateway, { downloadVisible: false });
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.equal(artifact.fileName, "flow-result.png");
    assert.equal(gateway.downloadCalls, 1);
    assert.deepEqual(gateway.hovered, { role: "img", name: "Generated image 1", exact: true, visible: true, enabled: true });
    assert.equal(gateway.operations.filter((operation) => operation === "click").length, 2, "Generate once, plus the result menu");
    assert.equal(clicks(gateway), 1);
    assert.deepEqual((await readFile(artifact.sourcePath)).subarray(1, 4).toString(), "PNG");
  });
});

test("a download failure retries the same result without regenerating", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-download-failure");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    gateway.fail("download");
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1, "a failed download never starts another generation");
    assert.equal((await provider.attemptState("flow-download-failure")).phase, "RESULT_DETECTED");

    gateway.setPage({ failOps: [] });
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.ok(artifact.sourcePath);
    assert.equal(gateway.downloadCalls, 2);
    assert.equal(clicks(gateway), 1);
    assert.equal((await provider.attemptState("flow-download-failure")).phase, "RESULT_STORED");
  });
});

test("a timed-out download is a distinct classification from a failed one", async () => {
  await withFlow({ timeoutOps: ["download"] }, async ({ provider, gateway }) => {
    const input = request("flow-download-timeout");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_TIMEOUT, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
    assert.equal(gateway.downloadCalls, 1);
    assert.equal((await provider.attemptState("flow-download-timeout")).hasDownloadedArtifact, false);
  });
});

test("bytes that cannot be described as an image are refused as invalid artifacts", async () => {
  await withFlow({ downloadOutcome: "bytes" }, async ({ provider, gateway }) => {
    const input = request("flow-invalid-artifact");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.INVALID_ARTIFACT, { submissionUnknown: true }),
    );
    const state = await provider.attemptState("flow-invalid-artifact");
    assert.equal(state.hasDownloadedArtifact, false, "invalid bytes are never recorded as a stored result");
    assert.equal(clicks(gateway), 1, "an invalid artifact is re-downloaded, never regenerated");

    gateway.setPage({ downloadOutcome: "png" });
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.equal(artifact.mimeType, "image/png");
    assert.equal(gateway.downloadCalls, 2);
  });
});

test("a nameless download is described by its own signature instead of being rejected", async () => {
  await withFlow({ downloadOutcome: "bin" }, async ({ provider, gateway }) => {
    const input = request("flow-signature-sniff");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.equal(artifact.fileName, "flow-result.bin");
    assert.equal(artifact.mimeType, "image/png", "the bytes decide the type the asset store records");
    assert.deepEqual(await readFile(artifact.sourcePath), tinyPng());
  });
});

test("a hover that does not land on the correlated element stops the download", async () => {
  await withFlow({ hoverFails: true }, async ({ provider, gateway }) => {
    const input = request("flow-hover-fails");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.DOWNLOAD_FAILED, { submissionUnknown: true }),
    );
    assert.equal(gateway.downloadCalls, 0, "Download is not pressed for an element the pointer never reached");
    assert.equal(clicks(gateway), 1);
  });
});

test("a result whose correlation fingerprint no longer matches is not downloaded", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-result-changed");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    assert.equal((await provider.downloadResult(handle.providerJobId, input)).length, 1);

    // The correlated element is replaced afterwards; the stored bytes stay, but no blind re-download
    // is allowed against a page that no longer proves the same result.
    await rm(path.join(provider.rootDir, "downloads"), { recursive: true, force: true });
    await mkdir(path.join(provider.rootDir, "downloads"), { recursive: true });
    const recordPath = path.join(provider.rootDir, "records", `${handle.providerJobId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, resultPath: undefined, fileName: undefined }), "utf8");
    gateway.setPage({ resultMedia: 2 });
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
  });
});

// -------------------------------------------------------------------------------------------
// Request validation, cancellation, and diagnostics
// -------------------------------------------------------------------------------------------

test("anything beyond the verified single-image unit is refused before the browser is touched", async () => {
  const rejected = [
    ["references", { references: ["/tmp/reference.png"] }],
    ["video mode", { parameters: { mode: "video", outputCount: 1 } }],
    ["batch", { parameters: { mode: "image", outputCount: 3 } }],
    ["start frame", { parameters: { mode: "image", outputCount: 1, startFrame: "x" } }],
    ["end frame", { parameters: { mode: "image", outputCount: 1, endFrame: "x" } }],
    ["unverified setting", { parameters: { mode: "image", outputCount: 1, model: "veo-3.1" } }],
    ["empty prompt", { prompt: "   " }],
    ["empty request key", { providerRequestKey: "" }],
    ["other provider", { provider: "mock" }],
  ];
  await withFlow({}, async ({ provider, gateway }) => {
    for (const [label, overrides] of rejected) {
      await assert.rejects(
        () => provider.createGeneration(request(`flow-reject-${label}`, overrides)),
        rejectsFlow(GOOGLE_FLOW_ERROR_CODES.UNSUPPORTED_REQUEST, { retryable: false, submissionUnknown: false }),
        label,
      );
    }
    assert.deepEqual(pageOperations(gateway), [], "capability rejection must not reach the browser at all");
    assert.equal(gateway.pollCalls, 0);
    assert.equal(gateway.fillCalls, 0);
  });
});

test("cancel is final locally and refuses to stop an uncorrelated remote generation", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-cancel-pending");
    const handle = await provider.createGeneration(input);
    await assert.rejects(
      () => provider.cancelGeneration(handle.providerJobId),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CANCEL_UNAVAILABLE, { retryable: false }),
    );
    assert.equal(clicks(gateway), 1, "only the original submission was ever clicked");
    assert.equal(gateway.operations.filter((operation) => operation === "click").length, 1, "no generic Stop control is pressed");
  });
});

test("cancelling a provably unsubmitted record is local-only and needs no browser action", async () => {
  await withFlow({ echoPrompt: false }, async ({ provider, gateway }) => {
    const input = request("flow-cancel-unsubmitted");
    await assert.rejects(
      () => provider.createGeneration(input),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.PROMPT_NOT_VISIBLE),
    );
    const state = await provider.attemptState("flow-cancel-unsubmitted");
    assert.equal(state.phase, "NOT_SUBMITTED");
    await provider.cancelGeneration(state.providerJobId);
    assert.equal((await provider.attemptState("flow-cancel-unsubmitted")).phase, "CANCELLED");
    assert.equal(clicks(gateway), 0);
    assert.equal(gateway.operations.filter((operation) => operation === "click").length, 0);
  });
});

test("attemptState is read-only: it never clicks, writes, or adds a polling cycle", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    assert.equal(await provider.attemptState("flow-unknown-key"), null, "no record is a null answer, not an error");
    const input = request("flow-readonly");
    const handle = await provider.createGeneration(input);
    const polls = gateway.pollCalls;
    const resolves = gateway.resolveCalls;
    for (let index = 0; index < 5; index += 1) await provider.attemptState("flow-readonly");
    assert.equal(gateway.pollCalls, polls, "a diagnostic must not add polling load");
    assert.equal(gateway.resolveCalls, resolves);
    assert.equal(clicks(gateway), 1);
    assert.equal(gateway.downloadCalls, 0);
    assert.equal(handle.status, "RUNNING");
  });
});

test("a lookup without its matching request cannot guess that the prompt still belongs to this attempt", async () => {
  await withFlow({}, async ({ provider, gateway }) => {
    const input = request("flow-missing-context");
    const handle = await provider.createGeneration(input);
    completeGeneration(gateway);
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId),
      rejectsFlow(GOOGLE_FLOW_ERROR_CODES.CORRELATION_AMBIGUOUS, { submissionUnknown: true }),
    );
    assert.equal(clicks(gateway), 1);
    assert.equal(gateway.downloadCalls, 0, "correlation context is a precondition for downloading");
  });
});

// -------------------------------------------------------------------------------------------
// Identity, capability surface, and hygiene
// -------------------------------------------------------------------------------------------

test("the provider identity and declared capabilities stay narrow and honest", async () => {
  assert.equal(GOOGLE_FLOW_PROVIDER_ID, "google-flow");
  assert.deepEqual(GOOGLE_FLOW_CAPABILITIES, {
    imageGeneration: true,
    videoGeneration: false,
    referenceImages: false,
    startFrame: false,
    endFrame: false,
    batchGeneration: false,
  });
  await withFlow({}, async ({ provider, gateway }) => {
    assert.equal(provider.id, GOOGLE_FLOW_PROVIDER_ID);
    assert.equal(provider.capabilities, GOOGLE_FLOW_CAPABILITIES, "capabilities are the frozen advertised set");
    assert.deepEqual(pageOperations(gateway), [], "constructing the adapter touches no page");
    const session = await provider.inspectSession();
    assert.deepEqual(pageOperations(gateway), ["state", "observe", "resolve", "resolve"], "reading a page needs no writes");
    assert.ok(session.sessionId);
  });
});

test("the provider keeps one code per failure family and names the documented aliases", async () => {
  const codes = Object.values(GOOGLE_FLOW_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length, "each code names exactly one family");
  for (const required of [
    "EDITOR_NOT_FOUND",
    "GENERATE_CONTROL_NOT_FOUND",
    "PROMPT_INPUT_NOT_FOUND",
    "PAGE_NOT_READY",
    "SUBMISSION_FAILED",
    "DOWNLOAD_FAILED",
    "INVALID_ARTIFACT",
  ]) {
    assert.ok(codes.includes(GOOGLE_FLOW_ERROR_CODES[required]), `${required} must be a distinct code`);
  }
  assert.equal(GOOGLE_FLOW_ERROR_CODES.PROMPT_FILL_FAILED, "FLOW_PROMPT_FILL_FAILED");
  assert.equal(GOOGLE_FLOW_ERROR_CODES.RESULT_NOT_READY, "FLOW_RESULT_NOT_READY");
});

test("no prompt body, page text, credential, or session material is ever persisted or reported", async () => {
  const scenarios = [
    {},
    { auth: true },
    { blocked: true },
    { noPage: true },
    { echoPrompt: false },
    { generate: "missing" },
    { clickResult: "unverified" },
    { clickResult: "unconfirmed-timeout" },
    { downloadOutcome: "bytes" },
    { hoverFails: true },
    { promptEditor: "ambiguous" },
    { busy: true },
    { readyState: "loading" },
    { downloadVisible: false, downloadNeedsMenu: true },
  ];
  const reported = [];
  for (const scenario of scenarios) {
    const outcome = await withFlow(scenario, async ({ provider, gateway, directory }) => {
      const key = `hygiene-${Object.entries(scenario).map(([name, value]) => `${name}${value}`).join("-") || "plain"}`;
      const input = request(key);
      const lines = [JSON.stringify(await provider.inspectSession())];
      try {
        const handle = await provider.createGeneration(input);
        completeGeneration(gateway);
        lines.push(JSON.stringify(await provider.getGenerationStatus(handle.providerJobId, input)));
        lines.push(JSON.stringify(await provider.downloadResult(handle.providerJobId, input)));
      } catch (error) {
        lines.push(`${error.code} ${error.message}`);
      }
      lines.push(JSON.stringify(await provider.attemptState(key)));
      lines.push(gateway.operations.join(","));

      for (const file of await collectFiles(directory)) {
        for (const marker of SECRET_MARKERS) {
          assert.equal(file.contents.includes(marker), false, `${marker} must never be written to ${file.relative}`);
        }
        assert.equal(/cookie|authorization|password|localStorage|innerHTML/i.test(file.contents), false, `no credential or document material in ${file.relative}`);
        assert.match(
          file.relative,
          /^(records\/flow-[a-f0-9]{64}\.json|downloads\/flow-result\.(png|bin))$/,
          "only the recovery record and the correlated download are written",
        );
      }
      return lines;
    });
    reported.push(...outcome);
  }
  for (const line of reported) {
    for (const marker of SECRET_MARKERS) {
      assert.equal(line.includes(marker), false, `${marker} must never be reported`);
    }
  }
});

test("the sanitized session summary is the only page information the adapter exposes", async () => {
  await withFlow({ auth: true }, async ({ provider }) => {
    const session = await provider.inspectSession();
    assert.deepEqual(Object.keys(session).sort(), ["activeUrl", "browserState", "provider", "reasonCode", "sessionId", "status"]);
    assert.equal(session.activeUrl, "https://labs.google/fx/tools/flow");
    const legacy = await provider.inspectState();
    assert.deepEqual(Object.keys(legacy).sort(), ["activeUrl", "browser", "provider", "reasonCode", "sessionId", "status"]);
  });
});

async function collectFiles(root) {
  const found = [];
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, relative);
      else found.push({ relative, contents: await readFile(child, "latin1").catch(() => "<unreadable>") });
    }
  };
  await walk(root, "");
  return found;
}
