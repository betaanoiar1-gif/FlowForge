import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationProviderError } from "@flowforge/core";
import { BrowserGatewayError } from "@flowforge/browser";
import { GoogleFlowProvider } from "../dist/index.js";

class FakeFlowBrowser {
  sessionId = "cdp-test-session";
  connected = false;
  url = "https://labs.google/fx/tools/flow";
  prompt = "";
  visibleText = "Image Video";
  mode = "image";
  behavior = "running";
  clickCount = 0;
  clickQueries = [];
  downloadCount = 0;
  downloadFails = false;
  hoverQuery = null;
  downloadVisible = false;
  media = [];

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async state() { return this.connected ? "CONNECTED" : "DISCONNECTED"; }
  async tabs() { return [{ id: "tab-1", url: this.url, title: "Flow" }]; }
  async selectTab() {}
  async open(url) { this.url = url; }
  async screenshot() { return new Uint8Array(); }
  async discoverPage() { return await this.observe(); }
  async domDiagnostics() { return { inputs: [], buttons: [] }; }
  async waitFor(query) { return this.resolve(query); }
  async hover(query) { this.hoverQuery = query; return true; }
  async upload() { return { fileNames: [] }; }

  async observe() {
    const selectedName = this.mode === "video" ? "Video" : "Image";
    const elements = [
      this.promptElement(),
      this.generateElement(),
      {
        tagName: "button", role: "button", accessibleName: "Image", text: "Image", href: null,
        inputType: null, contenteditable: false, disabled: false, visible: true,
        selected: this.mode === "image",
      },
      {
        tagName: "button", role: "button", accessibleName: "Video", text: "Video", href: null,
        inputType: null, contenteditable: false, disabled: false, visible: true,
        selected: this.mode === "video",
      },
      ...this.media,
    ];
    void selectedName;
    return { url: this.url, title: "Flow", readyState: "complete", elements, visibleText: this.visibleText };
  }

  async resolve(query) {
    if (query.role === "textbox" && query.contenteditable === true) {
      return { matched: true, count: 1, element: this.promptElement() };
    }
    if (query.name instanceof RegExp) {
      if (query.name.test("Construction begins") || query.name.test("Generate")) {
        return { matched: true, count: 1, element: this.generateElement() };
      }
      if (query.name.test("Download")) {
        return this.downloadVisible
          ? { matched: true, count: 1, element: this.button("Download") }
          : { matched: false, count: 0, element: null };
      }
      if (query.name.test("More")) {
        return { matched: false, count: 0, element: null };
      }
    }
    return { matched: false, count: 0, element: null };
  }

  async fill(_query, value, _timeout, options = {}) {
    if (options.expectedBeforeValue !== undefined && this.prompt !== options.expectedBeforeValue) {
      return {
        action: "fill", query: _query, matched: true, verified: false,
        beforeLength: this.prompt.length, afterLength: this.prompt.length, error: "value changed",
      };
    }
    const beforeValue = this.prompt;
    this.prompt = value;
    if (value) this.visibleText = `Image Video ${value}`;
    else this.visibleText = "Image Video";
    return { action: "fill", query: _query, matched: true, verified: true, beforeLength: beforeValue.length, afterLength: value.length };
  }

  async click(query) {
    this.clickQueries.push(query);
    if (query.name instanceof RegExp && (query.name.test("Generate") || query.name.test("Construction begins"))) {
      this.clickCount += 1;
      if (this.behavior === "running") this.visibleText = `Image Video ${this.prompt} Generating`;
      if (this.behavior === "ambiguous") this.visibleText = `Image Video ${this.prompt}`;
      if (this.behavior === "failure") this.visibleText = `Image Video ${this.prompt} could not generate this image`;
      if (this.behavior === "success") {
        this.visibleText = `Image Video ${this.prompt} Image generated`;
        this.media.push({
          tagName: "img", role: "img", accessibleName: "Generated image", text: "",
          href: null, inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
        });
        this.downloadVisible = true;
      }
      return {
        action: "click", query, matched: true, dispatched: true, verified: this.behavior !== "ambiguous",
        beforeUrl: this.url, afterUrl: this.url, beforeTitle: "Flow", afterTitle: "Flow",
      };
    }
    return {
      action: "click", query, matched: false, dispatched: false, verified: false,
      beforeUrl: this.url, afterUrl: this.url, beforeTitle: "Flow", afterTitle: "Flow",
      error: "not found",
    };
  }

  async download(_query, destinationDirectory) {
    this.downloadCount += 1;
    if (this.downloadFails) throw new BrowserGatewayError("Browser download timed out.", { timedOut: true });
    const fileName = `flow-download-${this.downloadCount}.png`;
    const filePath = path.join(destinationDirectory, fileName);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(filePath, Buffer.from("fake-flow-image"));
    return { path: filePath, fileName };
  }

  promptElement() {
    return {
      tagName: "div", role: "textbox", accessibleName: "Prompt", text: this.prompt,
      href: null, inputType: null, contenteditable: true, disabled: false, visible: true, selected: null,
    };
  }

  generateElement() {
    return {
      tagName: "button", role: "button", accessibleName: "Construction begins", text: "Generate",
      href: null, inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
    };
  }

  button(name) {
    return {
      tagName: "button", role: "button", accessibleName: name, text: name,
      href: null, inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
    };
  }
}

function request(providerRequestKey, overrides = {}) {
  return {
    projectId: "project-1",
    sceneId: "scene-1",
    sceneVersionId: "scene-version-1",
    prompt: "A quiet lighthouse at sunrise, viewed from the shore.",
    references: [],
    provider: "google-flow",
    parameters: { mode: "image", outputCount: 1 },
    metadata: {},
    jobId: "job-1",
    logicalIdempotencyKey: "logical-key-1",
    providerRequestKey,
    attemptNumber: 1,
    ...overrides,
  };
}

async function withProvider(options, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-google-flow-"));
  const browser = options.browser ?? new FakeFlowBrowser();
  await browser.connect();
  const provider = new GoogleFlowProvider(browser, { rootDir: directory });
  try {
    await run({ provider, browser, directory });
  } finally {
    await browser.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}


test("network diagnostics persist sanitized metadata without response bodies", async () => {
  await withProvider({}, async ({ provider, browser, directory }) => {
    browser.startNetworkDiagnostics = async () => ({
      async stop() {
        return [
          {
            kind: "request",
            requestId: "request-secret-id",
            url: "https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute",
            method: "POST",
            resourceType: "XHR",
            timestamp: 100,
            body: "SECRET-REQUEST-BODY",
          },
          {
            kind: "response",
            requestId: "response-secret-id",
            url: "https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute",
            status: 200,
            resourceType: "XHR",
            timestamp: 101,
            body: "SECRET-RESPONSE-BODY",
          },
        ];
      },
    });

    process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS = "1";
    process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS_BODY = "1";
    process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS_POST_CLICK_MS = "0";

    try {
      browser.behavior = "success";

      const input = request("request-key-network-persistence");
      const handle = await provider.createGeneration(input);

      const networkPath = path.join(
        directory,
        "records",
        `${handle.providerJobId}.network.json`,
      );

      const network = JSON.parse(
        await readFile(networkPath, "utf8"),
      );

      assert.equal(network.schemaVersion, 1);
      assert.equal(network.provider, "google-flow");
      assert.equal(network.providerJobId, handle.providerJobId);
      assert.equal(network.recordCount, 2);
      assert.equal(network.records.length, 2);

      assert.equal(network.records[0].kind, "request");
      assert.equal(network.records[0].method, "POST");
      assert.equal(network.records[0].resourceType, "XHR");

      assert.equal(network.records[1].kind, "response");
      assert.equal(network.records[1].status, 200);
      assert.equal(network.records[1].resourceType, "XHR");

      const serialized = JSON.stringify(network);

      assert.equal(
        serialized.includes("SECRET-REQUEST-BODY"),
        false,
        "request response body must never be persisted",
      );

      assert.equal(
        serialized.includes("SECRET-RESPONSE-BODY"),
        false,
        "response body must never be persisted",
      );

      assert.equal(
        serialized.includes("request-secret-id"),
        false,
        "requestId must never be persisted",
      );

      assert.equal(
        serialized.includes("response-secret-id"),
        false,
        "requestId must never be persisted",
      );

      const manifest = JSON.parse(
        await readFile(
          path.join(
            directory,
            "records",
            `${handle.providerJobId}.json`,
          ),
          "utf8",
        ),
      );

      assert.equal(
        manifest.schemaVersion,
        1,
        "network diagnostics must not modify the recovery manifest schema",
      );

      assert.equal(
        browser.clickCount,
        1,
        "diagnostics must not cause an additional Generate submission",
      );
    } finally {
      delete process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS;
      delete process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS_BODY;
      delete process.env.FLOWFORGE_GOOGLE_FLOW_NETWORK_DIAGNOSTICS_POST_CLICK_MS;
    }
  });
});

test("prompt-only diagnostics clear only the exact text prepared by the same provider instance", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const preparedPrompt = "FLOWFORGE PROMPT DISCOVERY TEST";
    await provider.preparePrompt(preparedPrompt);
    assert.equal(browser.prompt, preparedPrompt);

    browser.prompt = "new user text";
    browser.visibleText = `Image Video ${browser.prompt}`;
    await assert.rejects(
      () => provider.clearPrompt(),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_PROMPT_FILL_FAILED",
    );
    assert.equal(browser.prompt, "new user text", "the clear guard must preserve text changed by the user");
    assert.equal(browser.clickCount, 0);
  });
});

test("session inspection reports manual auth state without exposing visible page contents", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    browser.visibleText = "Sign in to continue";
    const status = await provider.inspectSession();
    assert.equal(status.status, "AUTH_REQUIRED");
    assert.equal(status.reasonCode, "MANUAL_GOOGLE_AUTH_REQUIRED");
    assert.equal("visibleText" in status, false);
    assert.equal("cookies" in status, false);
  });
});

test("submits one image through visible browser actions, recovers it, and downloads only a correlated result", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const input = request("request-key-success");
    assert.equal(await provider.findGeneration(input.providerRequestKey), null);

    browser.behavior = "success";
    const handle = await provider.createGeneration(input);
    assert.deepEqual(handle, { providerJobId: handle.providerJobId, status: "RUNNING" });
    assert.match(handle.providerJobId, /^flow-[a-f0-9]{64}$/);
    assert.equal(browser.clickCount, 1);

    const recovered = await provider.findGeneration(input.providerRequestKey, input);
    assert.equal(recovered.providerJobId, handle.providerJobId);
    assert.equal(recovered.status, "SUCCEEDED");
    assert.equal(browser.clickCount, 1, "recovery must not dispatch a second Generate action");
    const duplicate = await provider.createGeneration(input);
    assert.equal(duplicate.providerJobId, handle.providerJobId);
    assert.equal(duplicate.status, "SUCCEEDED");
    assert.equal(browser.clickCount, 1, "repeating the same request key must be idempotent");

    const snapshot = await provider.getGenerationStatus(handle.providerJobId, input);
    assert.equal(snapshot.status, "SUCCEEDED");
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.equal(artifact.outputIndex, 0);
    assert.equal(artifact.mimeType, "image/png");
    assert.ok((await stat(artifact.sourcePath)).isFile());
    assert.equal((await readFile(artifact.sourcePath, "utf8")), "fake-flow-image");
    assert.equal(browser.downloadCount, 1);
    assert.deepEqual(browser.hoverQuery, { role: "img", name: "Generated image", exact: true, visible: true, enabled: true });

    const manifest = JSON.parse(await readFile(path.join(directoryFor(provider), "records", `${handle.providerJobId}.json`), "utf8"));
    assert.equal(manifest.state, "SUCCEEDED");
    const manifestText = JSON.stringify(manifest);
    assert.equal("prompt" in manifest, false, "the duplicate plaintext prompt is not copied to the provider manifest");
    assert.equal(manifestText.includes(input.prompt), false, "the prompt text must not be persisted in the provider manifest");
    assert.match(manifest.promptHash, /^[a-f0-9]{64}$/);
    for (const secretMarker of ["password", "cookie", "access-token"]) {
      assert.equal(manifestText.includes(secretMarker), false, `${secretMarker} must not be persisted`);
    }
  });
});

// The provider intentionally exposes rootDir so tests can assert durable files without special hooks.
function directoryFor(provider) { return provider.rootDir; }

test("video media is never accepted by the single-image provider capability", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const input = request("request-key-video-result");
    const handle = await provider.createGeneration(input);
    browser.media = [{
      tagName: "video", role: "video", accessibleName: "Generated video", text: "",
      href: null, inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
    }];
    browser.visibleText = `Image Video ${input.prompt} Generation complete`;
    await assert.rejects(
      () => provider.getGenerationStatus(handle.providerJobId, input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_CORRELATION_AMBIGUOUS",
    );
    assert.equal(browser.clickCount, 1);
  });
});

test("an ambiguous post-click page is never accepted or blindly resubmitted after provider restart", async () => {
  await withProvider({}, async ({ provider, browser, directory }) => {
    const input = request("request-key-ambiguous");
    browser.behavior = "ambiguous";
    await assert.rejects(
      () => provider.createGeneration(input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_TIMEOUT" && error.submissionUnknown === true,
    );
    assert.equal(browser.clickCount, 1);

    const restartedProvider = new GoogleFlowProvider(browser, { rootDir: directory });
    await assert.rejects(
      () => restartedProvider.findGeneration(input.providerRequestKey, input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_CORRELATION_AMBIGUOUS" && error.submissionUnknown === true,
    );
    assert.equal(browser.clickCount, 1);
  });
});

test("a visible active-generation signal is correlated to the same attempt after restart", async () => {
  await withProvider({}, async ({ provider, browser, directory }) => {
    const input = request("request-key-running");
    const handle = await provider.createGeneration(input);
    browser.connected = false;
    const restartedProvider = new GoogleFlowProvider(browser, { rootDir: directory });
    const recovered = await restartedProvider.findGeneration(input.providerRequestKey, input);
    assert.equal(browser.connected, true, "recovery reattaches to the configured browser endpoint without authentication automation");
    assert.equal(recovered.providerJobId, handle.providerJobId);
    assert.equal(recovered.status, "RUNNING");
    assert.equal(browser.clickCount, 1);
  });
});

test("rejects mismatched requests and hardened recovery-record violations without resubmitting", async () => {
  await withProvider({}, async ({ provider, browser, directory }) => {
    const input = request("request-key-record-hardening");
    const handle = await provider.createGeneration(input);
    const mismatchedRequest = request(input.providerRequestKey, { prompt: "A different prompt must not reuse this key." });
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, mismatchedRequest),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_CORRELATION_AMBIGUOUS",
    );
    const wrongAttempt = request(input.providerRequestKey, { attemptNumber: 2 });
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, wrongAttempt),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_CORRELATION_AMBIGUOUS",
    );

    const manifestPath = path.join(directory, "records", `${handle.providerJobId}.json`);
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...original, state: "UNRECOGNIZED" }));
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_SUBMISSION_UNKNOWN",
    );

    await writeFile(manifestPath, JSON.stringify({
      ...original,
      resultPath: path.resolve(directory, "..", "outside-flow-result.png"),
      fileName: "outside-flow-result.png",
    }));
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_SUBMISSION_UNKNOWN",
    );
    assert.equal(browser.clickCount, 1, "invalid recovery records must never trigger another Generate click");
  });
});

test("does not click a generic Flow stop control to cancel an uncorrelated remote job", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const handle = await provider.createGeneration(request("request-key-cancel-safe"));
    await assert.rejects(
      () => provider.cancelGeneration(handle.providerJobId),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_CANCEL_UNAVAILABLE",
    );
    assert.equal(browser.clickCount, 1, "only the original Generate click may have occurred");
    assert.equal(browser.clickQueries.length, 1, "remote cancellation must not click a generic Stop or Cancel control");
  });
});

test("refuses to correlate a persisted attempt against a different browser session", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const input = request("request-key-session-mismatch");
    await provider.createGeneration(input);
    browser.sessionId = "cdp-different-session";
    await assert.rejects(
      () => provider.findGeneration(input.providerRequestKey, input),
      (error) => error instanceof GenerationProviderError && error.submissionUnknown === true,
    );
    assert.equal(browser.clickCount, 1);
  });
});

test("advertises and enforces only the fake-tested single-image workflow", async (t) => {
  await withProvider({}, async ({ provider, browser }) => {
    assert.deepEqual(provider.capabilities, {
      imageGeneration: true,
      videoGeneration: false,
      referenceImages: false,
      startFrame: false,
      endFrame: false,
      batchGeneration: false,
    });
    await t.test("references", async () => {
      await assert.rejects(
        () => provider.createGeneration(request("request-key-ref", { references: ["/tmp/ref.png"] })),
        (error) => error instanceof GenerationProviderError && error.code === "FLOW_UNSUPPORTED_REQUEST",
      );
    });
    await t.test("video request mode", async () => {
      await assert.rejects(
        () => provider.createGeneration(request("request-key-video", { parameters: { mode: "video" } })),
        (error) => error instanceof GenerationProviderError && error.code === "FLOW_UNSUPPORTED_REQUEST",
      );
    });
    await t.test("conflicting modes, batches, and unverified settings", async () => {
      for (const parameters of [
        { mode: "image", mediaType: "video" },
        { mode: "image", outputCount: 2 },
        { mode: "image", aspectRatio: "16:9" },
      ]) {
        await assert.rejects(
          () => provider.createGeneration(request(`request-key-settings-${Object.keys(parameters).join("-")}`, { parameters })),
          (error) => error instanceof GenerationProviderError && error.code === "FLOW_UNSUPPORTED_REQUEST",
        );
      }
    });
    await t.test("visibly selected video mode", async () => {
      browser.mode = "video";
      await assert.rejects(
        () => provider.createGeneration(request("request-key-visible-video")),
        (error) => error instanceof GenerationProviderError && error.code === "FLOW_UNSUPPORTED_REQUEST",
      );
      browser.mode = "image";
    });
    await t.test("existing user text", async () => {
      browser.prompt = "do not overwrite this";
      browser.visibleText = `Image Video ${browser.prompt}`;
      await assert.rejects(
        () => provider.createGeneration(request("request-key-non-empty")),
        (error) => error instanceof GenerationProviderError && error.code === "FLOW_PROMPT_FILL_FAILED",
      );
      assert.equal(browser.clickCount, 0);
      assert.equal(browser.prompt, "do not overwrite this");
    });
  });
});

test("authentication, security blocks, and changed UI never dispatch a Generate click", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    browser.visibleText = "Sign in to continue";
    await assert.rejects(
      () => provider.createGeneration(request("request-key-auth")),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_AUTH_REQUIRED",
    );
    assert.equal(browser.clickCount, 0);

    browser.visibleText = "Complete CAPTCHA to continue";
    await assert.rejects(
      () => provider.createGeneration(request("request-key-blocked")),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_ACCESS_BLOCKED",
    );
    assert.equal(browser.clickCount, 0);

    browser.visibleText = "Image Video";
    browser.mode = "unknown";
    await assert.rejects(
      () => provider.createGeneration(request("request-key-ui-changed")),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_UI_CHANGED",
    );
    assert.equal(browser.clickCount, 0);
  });
});

test("download timeout is a typed download failure and retries the existing result without generating again", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    const input = request("request-key-download-timeout");
    browser.behavior = "success";
    const handle = await provider.createGeneration(input);
    browser.downloadFails = true;
    await assert.rejects(
      () => provider.downloadResult(handle.providerJobId, input),
      (error) => error instanceof GenerationProviderError && error.code === "FLOW_DOWNLOAD_TIMEOUT" && error.submissionUnknown === true,
    );

    browser.downloadFails = false;
    const [artifact] = await provider.downloadResult(handle.providerJobId, input);
    assert.ok((await stat(artifact.sourcePath)).isFile());
    assert.equal(browser.clickCount, 1, "download recovery must not submit another generation");
    assert.equal(browser.downloadCount, 2);
  });
});

test("a visibly correlated generation failure is reported as terminal and is not retried by the provider", async () => {
  await withProvider({}, async ({ provider, browser }) => {
    browser.behavior = "failure";
    const handle = await provider.createGeneration(request("request-key-failure"));
    const status = await provider.getGenerationStatus(handle.providerJobId, request("request-key-failure"));
    assert.equal(status.status, "FAILED");
    assert.equal(status.errorCode, "FLOW_GENERATION_FAILED");
    assert.equal(status.retryable, false);
    assert.equal(browser.clickCount, 1);
  });
});
