import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemAssetStore } from "../../../packages/assets/dist/index.js";
import { LocalQueueWorker, SqliteJobQueue } from "../../../packages/queue/dist/index.js";
import { SqliteJobRepository } from "../../../packages/storage/dist/index.js";
import { GoogleFlowProvider } from "../dist/index.js";

class SuccessfulFakeFlowBrowser {
  sessionId = "cdp-provider-contract";
  prompt = "";
  visibleText = "Image Video";
  clicked = 0;
  clickQueries = [];
  clickOutcome = "success";
  media = [];
  connected = false;

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async state() { return this.connected ? "CONNECTED" : "DISCONNECTED"; }
  async tabs() { return [{ id: "flow-tab", url: "https://labs.google/fx/tools/flow", title: "Flow" }]; }
  async selectTab() {}
  async open() {}
  async screenshot() { return new Uint8Array(); }
  async discoverPage() { return this.observe(); }
  async domDiagnostics() { return { inputs: [], buttons: [] }; }
  async waitFor(query) { return this.resolve(query); }
  async hover() { return true; }
  async upload() { return { fileNames: [] }; }

  async observe() {
    const elements = [
      this.promptElement(),
      this.button("Construction begins", "Generate"),
      this.button("Image", "Image", true),
      this.button("Video", "Video", false),
      ...this.media,
    ];
    return {
      url: "https://labs.google/fx/tools/flow",
      title: "Flow",
      readyState: "complete",
      visibleText: this.visibleText,
      elements,
    };
  }

  async resolve(query) {
    if (query.role === "textbox" && query.contenteditable === true) {
      return { matched: true, count: 1, element: this.promptElement() };
    }
    if (query.name instanceof RegExp && (query.name.test("Generate") || query.name.test("Construction begins"))) {
      return { matched: true, count: 1, element: this.button("Construction begins", "Generate") };
    }
    if (query.name instanceof RegExp && query.name.test("Download")) {
      return { matched: true, count: 1, element: this.button("Download", "Download") };
    }
    return { matched: false, count: 0, element: null };
  }

  async fill(query, value, _timeout, options = {}) {
    if (options.expectedBeforeValue !== undefined && this.prompt !== options.expectedBeforeValue) {
      return { action: "fill", query, matched: true, verified: false, beforeLength: this.prompt.length, afterLength: this.prompt.length };
    }
    const beforeValue = this.prompt;
    this.prompt = value;
    this.visibleText = value ? `Image Video ${value}` : "Image Video";
    return { action: "fill", query, matched: true, verified: true, beforeLength: beforeValue.length, afterLength: value.length };
  }

  async click(query) {
    this.clicked += 1;
    this.clickQueries.push(query);
    if (this.clickOutcome === "success") this.showSuccess();
    else if (this.clickOutcome === "running") this.visibleText = `Image Video ${this.prompt} Generating`;
    else this.visibleText = `Image Video ${this.prompt}`;
    return {
      action: "click", query, matched: true, dispatched: true, verified: this.clickOutcome !== "ambiguous",
      beforeUrl: "https://labs.google/fx/tools/flow", afterUrl: "https://labs.google/fx/tools/flow",
      beforeTitle: "Flow", afterTitle: "Flow",
    };
  }

  showSuccess() {
    this.visibleText = `Image Video ${this.prompt} Image generated`;
    if (!this.media.some((element) => element.accessibleName === "Generated image")) {
      this.media.push({
        tagName: "img", role: "img", accessibleName: "Generated image", text: "",
        href: null, inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
      });
    }
  }

  async download(_query, destinationDirectory) {
    await mkdir(destinationDirectory, { recursive: true });
    const filePath = path.join(destinationDirectory, "flow-contract-result.png");
    await writeFile(filePath, makeTinyPng());
    return { path: filePath, fileName: "flow-contract-result.png" };
  }

  promptElement() {
    return {
      tagName: "div", role: "textbox", accessibleName: "Prompt", text: this.prompt,
      href: null, inputType: null, contenteditable: true, disabled: false, visible: true, selected: null,
    };
  }

  button(accessibleName, text, selected = null) {
    return {
      tagName: "button", role: "button", accessibleName, text, href: null,
      inputType: null, contenteditable: false, disabled: false, visible: true, selected,
    };
  }
}

test("GoogleFlowProvider fulfills the provider port through the existing durable queue, asset store, and deterministic QC", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-google-flow-contract-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const browser = new SuccessfulFakeFlowBrowser();
  const provider = new GoogleFlowProvider(browser, { rootDir: path.join(directory, "google-flow") });
  await browser.connect();
  try {
    const project = repository.createProject({ id: "flow-contract-project", name: "Flow contract" });
    const scene = repository.createScene({ id: "flow-contract-scene", projectId: project.id, sceneNumber: 1, title: "Test image" });
    const version = repository.createSceneVersion({
      id: "flow-contract-version",
      sceneId: scene.id,
      prompt: "A calm landscape with a small lighthouse.",
      references: [],
    });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: provider.id,
      parameters: { mode: "image", outputCount: 1 },
      maxAttempts: 2,
    });
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      provider,
      new FileSystemAssetStore(path.join(directory, "assets")),
      { workerId: "google-flow-contract-worker", retryDelayMs: 0 },
    );

    const result = await worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.qcStatus, "PASSED");
    assert.equal(browser.clicked, 1);

    const completed = repository.getGenerationJob(job.id);
    const attempt = repository.listGenerationAttempts(job.id)[0];
    const queueItem = repository.getQueueItemByJob(job.id);
    const assetVersion = repository.getAssetVersion(result.assetVersionId);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(queueItem.status, "ACKED");
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(attempt.provider, "google-flow");
    assert.equal(completed.externalId, attempt.providerJobId);
    assert.equal(assetVersion.generationAttemptId, attempt.id);
    assert.equal(assetVersion.generationJobId, job.id);
    assert.equal(repository.getQCResult(assetVersion.id).status, "PASSED");
  } finally {
    repository.close();
    await browser.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queue resumes an ambiguous Flow timeout on the same persisted attempt without a second Generate click", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-google-flow-resume-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const browser = new SuccessfulFakeFlowBrowser();
  browser.clickOutcome = "ambiguous";
  const provider = new GoogleFlowProvider(browser, { rootDir: path.join(directory, "google-flow") });
  await browser.connect();
  try {
    const project = repository.createProject({ id: "flow-resume-project", name: "Flow resume" });
    const scene = repository.createScene({ id: "flow-resume-scene", projectId: project.id, sceneNumber: 1, title: "Resume image" });
    const version = repository.createSceneVersion({
      id: "flow-resume-version",
      sceneId: scene.id,
      prompt: "A single orange leaf on a dark table.",
      references: [],
    });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: provider.id,
      parameters: { mode: "image", outputCount: 1 },
      maxAttempts: 2,
    });
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      provider,
      new FileSystemAssetStore(path.join(directory, "assets")),
      { workerId: "google-flow-resume-worker", retryDelayMs: 0, maxRecoveries: 4 },
    );

    const first = await worker.runOnce();
    assert.equal(first.status, "QUEUED");
    assert.equal(repository.listGenerationAttempts(job.id).length, 1);
    const attemptBeforeResume = repository.listGenerationAttempts(job.id)[0];
    assert.equal(attemptBeforeResume.status, "RUNNING");
    assert.equal(attemptBeforeResume.recoveryCount, 1);
    assert.equal(attemptBeforeResume.errorClass, "UNCERTAIN_PROVIDER_STATE", "the reused Phase 1 retry classification is unchanged");
    assert.equal(attemptBeforeResume.providerJobId, undefined, "the simulated crash window occurs before SQLite receives the remote ID");
    assert.equal(browser.clicked, 1);

    browser.showSuccess();
    const second = await worker.runOnce();
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(second.qcStatus, "PASSED");
    const attempts = repository.listGenerationAttempts(job.id);
    assert.equal(attempts.length, 1, "an uncertain Flow result must not create a new attempt");
    assert.equal(attempts[0].id, attemptBeforeResume.id);
    assert.ok(attempts[0].providerJobId, "recovery lookup must persist the already-created remote ID");
    assert.equal(attempts[0].status, "SUCCEEDED");
    assert.equal(browser.clicked, 1, "same-attempt recovery must not submit again");
  } finally {
    repository.close();
    await browser.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exhausted Flow uncertainty terminates the attempt and the existing durable guard still blocks unsafe retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-google-flow-exhaust-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const browser = new SuccessfulFakeFlowBrowser();
  browser.clickOutcome = "ambiguous";
  const provider = new GoogleFlowProvider(browser, { rootDir: path.join(directory, "google-flow") });
  await browser.connect();
  try {
    const project = repository.createProject({ id: "flow-exhaust-project", name: "Flow exhaust" });
    const scene = repository.createScene({ id: "flow-exhaust-scene", projectId: project.id, sceneNumber: 1, title: "Exhaust image" });
    const version = repository.createSceneVersion({
      id: "flow-exhaust-version",
      sceneId: scene.id,
      prompt: "A single grey stone on red sand.",
      references: [],
    });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: provider.id,
      parameters: { mode: "image", outputCount: 1 },
      maxAttempts: 2,
    });
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      provider,
      new FileSystemAssetStore(path.join(directory, "assets")),
      { workerId: "google-flow-exhaust-worker", retryDelayMs: 0, maxRecoveries: 1 },
    );

    assert.equal((await worker.runOnce()).status, "QUEUED");
    const result = await worker.runOnce();
    assert.equal(result.status, "FAILED", "bounded recovery ends visibly instead of looping");
    const attempts = repository.listGenerationAttempts(job.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "FAILED");
    assert.equal(attempts[0].errorClass, "UNCERTAIN_PROVIDER_STATE");
    assert.equal(attempts[0].recoveryCount, 2);
    assert.equal(browser.clicked, 1);
    assert.throws(
      () => repository.retryFailedJob(job.id, new Date().toISOString()),
      /uncertain or known provider result/,
      "the reused Phase 1 guard must reject a blind resubmission of uncertain Flow work",
    );
  } finally {
    repository.close();
    await browser.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("FlowForge local cancellation is final even when remote Google Flow cancellation is unavailable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-google-flow-cancel-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const browser = new SuccessfulFakeFlowBrowser();
  browser.clickOutcome = "running";
  const provider = new GoogleFlowProvider(browser, { rootDir: path.join(directory, "google-flow") });
  await browser.connect();
  try {
    const project = repository.createProject({ id: "flow-cancel-project", name: "Flow cancel" });
    const scene = repository.createScene({ id: "flow-cancel-scene", projectId: project.id, sceneNumber: 1, title: "Cancel image" });
    const version = repository.createSceneVersion({
      id: "flow-cancel-version",
      sceneId: scene.id,
      prompt: "A small paper boat on a quiet pond.",
      references: [],
    });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: provider.id,
      parameters: { mode: "image", outputCount: 1 },
      maxAttempts: 2,
    });
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      provider,
      new FileSystemAssetStore(path.join(directory, "assets")),
      { workerId: "google-flow-cancel-worker", retryDelayMs: 0 },
    );

    assert.equal((await worker.runOnce()).status, "QUEUED");
    assert.ok(repository.listGenerationAttempts(job.id)[0].providerJobId);
    const cancelled = await worker.cancel(job.id);
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(repository.listGenerationAttempts(job.id)[0].status, "CANCELLED");
    assert.equal(repository.getQueueItemByJob(job.id).status, "CANCELLED");
    assert.equal(browser.clicked, 1);
    assert.equal(browser.clickQueries.length, 1, "the adapter must not click a generic remote Stop control");
  } finally {
    repository.close();
    await browser.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

function makeTinyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixelRows = Buffer.from([
    0, 0x20, 0x80, 0xe0, 0xff, 0xf0, 0x30, 0x40, 0xff,
    0, 0x10, 0x30, 0x80, 0xff, 0xf0, 0xf0, 0x20, 0xff,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixelRows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
