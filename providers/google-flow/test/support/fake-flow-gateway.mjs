/**
 * Fake `BrowserGateway` for the real-provider boundary tests.
 *
 * It implements the existing gateway contract (`state/connect/observe/resolve/fill/click/hover/download`)
 * and nothing more, so every case below is proven through the same abstraction `CdpBrowserGateway`
 * implements — never a private protocol. It mirrors two behaviours that matter for safety:
 *
 * - editable contents are never exposed through discovery (the real gateway redacts them on purpose),
 *   so prompt integrity can only rest on the guarded fill result and the page's own visible text;
 * - `resolve()` only matches a unique enabled control unless `includeDisabled` is set.
 *
 * The counters are the point of the file: `generateClicks` (real side effects), `downloadCalls`,
 * `pollCalls` (page observations), plus an `operations` log used to prove that rejected requests never
 * touched the browser at all.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { BrowserGatewayError } from "@flowforge/browser";

export const FLOW_URL = "https://labs.google/fx/tools/flow";

export class FakeFlowGateway {
  sessionId = "cdp-fake-session";

  generateClicks = 0;
  downloadCalls = 0;
  pollCalls = 0;
  fillCalls = 0;
  resolveCalls = 0;
  hoverCalls = 0;
  operations = [];
  downloads = [];

  constructor(overrides = {}) {
    this.page = {
      url: FLOW_URL,
      title: "Flow",
      readyState: "complete",
      mode: "image",
      promptEditor: "unique",
      generate: "enabled",
      auth: false,
      blocked: false,
      busy: false,
      failureVisible: false,
      resultMedia: 0,
      echoPrompt: true,
      downloadVisible: false,
      downloadNeedsMenu: false,
      downloadOutcome: "png",
      clickResult: "verified",
      /** A dispatched Generate action makes the page busy; that is the only RUNNING evidence used. */
      busyOnSubmit: true,
      disconnected: false,
      noPage: false,
      failOps: [],
      timeoutOps: [],
      ...overrides,
    };
    this.connected = !this.page.disconnected;
    this.prompt = "";
    this.submitted = false;
  }

  /** Mutate the simulated page between worker passes, the way a real generation completes later. */
  setPage(changes) {
    this.page = { ...this.page, ...changes };
    return this.page;
  }

  fail(...operations) {
    this.page.failOps = [...this.page.failOps, ...operations];
  }

  timeOut(...operations) {
    this.page.timeoutOps = [...this.page.timeoutOps, ...operations];
  }

  get visibleText() {
    // Security and authentication states are only ever visible page text for this adapter, matching
    // the real gateway, which never exposes cookies, storage, or document internals.
    if (this.page.blocked) return "Complete CAPTCHA to continue";
    if (this.page.auth) return "Sign in to continue";
    const parts = ["Image Video"];
    if (this.prompt && this.page.echoPrompt) parts.push(this.prompt);
    if (this.page.busy) parts.push("Generating");
    if (this.page.failureVisible) parts.push("Could not generate this image");
    if (this.page.resultMedia > 0) parts.push("Image generated");
    return parts.join(" ");
  }

  #note(operation) {
    this.#record(operation);
    this.#check(operation);
  }

  #record(operation) {
    this.operations.push(operation);
  }

  #check(operation) {
    if (this.page.failOps.includes(operation)) throw new BrowserGatewayError(`Fake gateway ${operation} failed.`);
    if (this.page.timeoutOps.includes(operation)) {
      throw new BrowserGatewayError(`Fake gateway ${operation} timed out.`, { timedOut: true });
    }
  }

  async connect() {
    this.#note("connect");
    this.connected = !this.page.disconnected;
  }

  async disconnect() {
    this.operations.push("disconnect");
    this.connected = false;
  }

  async state() {
    this.operations.push("state");
    if (this.page.disconnected || !this.connected) return "DISCONNECTED";
    return this.page.noPage ? "PAGE_NOT_FOUND" : "CONNECTED";
  }

  async tabs() {
    return [{ id: "tab-1", url: this.page.url, title: this.page.title }];
  }

  async selectTab() {}

  async open(url) {
    this.#note("open");
    this.page.url = url;
  }

  async screenshot() {
    return new Uint8Array();
  }

  async discoverPage() {
    return this.#observation();
  }

  async observe() {
    this.pollCalls += 1;
    this.#note("observe");
    return this.#observation();
  }

  #observation() {
    const elements = [];
    if (this.page.mode !== null) {
      for (const label of ["Image", "Video"]) {
        elements.push(button(label, label, this.page.mode?.toLowerCase() === label.toLowerCase()));
      }
    }
    if (this.page.promptEditor !== "missing") elements.push(promptElement(this.prompt));
    if (this.page.generate !== "missing") {
      elements.push(button("Construction begins", "Generate", null, this.page.generate === "disabled"));
    }
    for (const name of this.mediaNames()) elements.push(image(name));
    if (this.page.downloadVisible) elements.push(button("Download", "Download"));
    return {
      url: this.page.url,
      title: this.page.title,
      readyState: this.page.readyState,
      elements,
      visibleText: this.visibleText,
    };
  }

  mediaNames() {
    return Array.from({ length: this.page.resultMedia }, (_unused, index) => `Generated image ${index + 1}`);
  }

  async domDiagnostics() {
    this.#note("domDiagnostics");
    return { inputs: [], buttons: [] };
  }

  async resolve(query) {
    this.resolveCalls += 1;
    this.#note("resolve");
    if (query.role === "textbox" && query.contenteditable === true) {
      if (this.page.promptEditor === "unique") return { matched: true, count: 1, element: promptElement(this.prompt) };
      if (this.page.promptEditor === "ambiguous") return { matched: false, count: 2, element: null };
      return { matched: false, count: 0, element: null };
    }
    const name = query.name;
    if (name instanceof RegExp && name.test("Construction begins")) {
      if (this.page.generate === "missing") return { matched: false, count: 0, element: null };
      if (this.page.generate === "ambiguous") return { matched: false, count: 2, element: null };
      const enabled = this.page.generate === "enabled";
      const acceptable = query.enabled === true ? enabled : query.includeDisabled === true || enabled;
      return acceptable
        ? { matched: true, count: 1, element: button("Construction begins", "Generate", null, !enabled) }
        : { matched: false, count: 1, element: null };
    }
    if (name instanceof RegExp && name.test("Download")) {
      return this.page.downloadVisible
        ? { matched: true, count: 1, element: button("Download", "Download") }
        : { matched: false, count: 0, element: null };
    }
    if (name instanceof RegExp && name.test("More")) {
      return this.page.downloadNeedsMenu
        ? { matched: true, count: 1, element: button("More", "More options") }
        : { matched: false, count: 0, element: null };
    }
    return { matched: false, count: 0, element: null };
  }

  async waitFor(query) {
    return this.resolve(query);
  }

  async fill(query, value, _timeoutMs, options = {}) {
    this.fillCalls += 1;
    this.#note("fill");
    if (options.expectedBeforeValue !== undefined && this.prompt !== options.expectedBeforeValue) {
      return {
        action: "fill", query, matched: true, verified: false, timedOut: false,
        beforeLength: this.prompt.length, afterLength: this.prompt.length, error: "editor value changed",
      };
    }
    const beforeLength = this.prompt.length;
    this.prompt = value;
    return { action: "fill", query, matched: true, verified: true, beforeLength, afterLength: value.length };
  }

  async click(query, _timeoutMs) {
    this.operations.push("click");
    const base = {
      action: "click", query, matched: true, dispatched: true, verified: true,
      beforeUrl: this.page.url, afterUrl: this.page.url, beforeTitle: this.page.title, afterTitle: this.page.title,
    };
    if (query.name instanceof RegExp && query.name.test("More")) {
      this.#check("click");
      this.page = { ...this.page, downloadVisible: true, downloadNeedsMenu: false };
      return base;
    }
    if (!(query.name instanceof RegExp) || !query.name.test("Construction begins")) {
      this.#check("click");
      return base;
    }
    const target = await this.resolve({ ...query, includeDisabled: true });
    if (!target.matched) {
      return { ...base, matched: false, dispatched: false, verified: false, error: "target is not unique" };
    }
    this.#check("click");
    this.generateClicks += 1;
    this.submitted = true;
    if (this.page.clickResult === "unverified") return { ...base, verified: false };
    if (this.page.clickResult === "unconfirmed-timeout") {
      return { ...base, dispatched: false, verified: false, timedOut: true };
    }
    if (this.page.clickResult === "refused") return { ...base, dispatched: false, verified: false };
    if (this.page.busyOnSubmit) this.page = { ...this.page, busy: true };
    return base;
  }

  async hover(query) {
    this.hoverCalls += 1;
    this.#note("hover");
    if (this.page.hoverFails) return false;
    this.hovered = query;
    return true;
  }

  async upload() {
    return { fileNames: [] };
  }

  async download(query, destinationDirectory) {
    this.downloadCalls += 1;
    this.#note("download");
    const target = await this.resolve(query);
    if (!target.matched) {
      throw new BrowserGatewayError("Fake gateway Download control is not unique.");
    }
    if (this.page.timeoutOps.includes("download")) {
      throw new BrowserGatewayError("Fake gateway download timed out.", { timedOut: true });
    }
    if (this.page.failOps.includes("download")) {
      throw new BrowserGatewayError("Fake gateway download failed.");
    }
    const fileName = this.page.downloadOutcome === "png" ? "flow-result.png" : "flow-result.bin";
    const filePath = path.join(destinationDirectory, fileName);
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(filePath, this.page.downloadOutcome === "bytes" ? Buffer.from("not an image") : tinyPng());
    this.downloads.push(filePath);
    return { path: filePath, fileName };
  }
}

function button(accessibleName, text, selected = null, disabled = false) {
  return {
    tagName: "button", role: "button", accessibleName, text, href: null,
    inputType: null, contenteditable: false, disabled, visible: true, selected,
  };
}

function image(accessibleName) {
  return {
    tagName: "img", role: "img", accessibleName, text: "", href: null,
    inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
  };
}

function promptElement(text) {
  return {
    tagName: "div", role: "textbox", accessibleName: "Prompt", text, href: null,
    inputType: null, contenteditable: true, disabled: false, visible: true, selected: null,
  };
}

/**
 * Completes the simulated generation. Flow finishes asynchronously, so the test drives the visible
 * result rather than the click handler, which keeps one submission provably separate from one result.
 */
export function completeGeneration(gateway, { mediaCount = 1, downloadVisible = true, failure = false } = {}) {
  gateway.setPage({
    busy: false,
    resultMedia: mediaCount,
    downloadVisible,
    failureVisible: failure,
  });
}

/** A real 2x2 PNG, so the imported bytes survive the existing deterministic QC validator. */
export function tinyPng() {
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
