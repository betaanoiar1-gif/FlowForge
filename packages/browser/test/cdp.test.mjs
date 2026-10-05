import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserGatewayError, CdpBrowserGateway } from "../dist/index.js";

class FakePage {
  constructor(url = "https://example.test/", text = "") {
    this.currentUrl = url;
    this.currentTitle = "Fake page";
    this.visibleText = text;
    this.value = "";
    this.elements = [
      {
        tagName: "button", role: "button", accessibleName: "Continue", text: "Continue", href: null,
        inputType: null, contenteditable: false, disabled: false, visible: true, selected: null,
      },
      {
        tagName: "div", role: "textbox", accessibleName: "Prompt", text: "", href: null,
        inputType: null, contenteditable: true, disabled: false, visible: true, selected: null,
      },
    ];
    this.clicked = 0;
    this.clickError = null;
    this.hovered = 0;
    this.uploaded = [];
    this.clickChangesText = false;
    this.executePageCallbacks = false;
    this.suggestedDownloadName = "provider-result.png";
    this.downloadError = null;
    this.downloadBytes = Buffer.from("fake-download-bytes");
  }

  url() { return this.currentUrl; }
  async title() { return this.currentTitle; }
  async screenshot() { return Buffer.from("fake-png"); }
  async waitForTimeout() { await Promise.resolve(); }

  async evaluate(callback, argument) {
    if (this.executePageCallbacks) return callback(argument);
    if (argument && typeof argument === "object" && "selector" in argument && "query" in argument) {
      const query = argument.query;
      const matches = this.elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => matchesQuery(element, query));
      return {
        match: {
          matched: matches.length === 1,
          count: matches.length,
          element: matches.length === 1 ? matches[0].element : null,
        },
        index: matches.length === 1 ? matches[0].index : null,
      };
    }
    if (typeof argument === "string") return this.elements;
    const source = callback.toString();
    if (source.includes("Never return live form values, page text, or raw HTML")) return callback();
    if (source.includes("document.readyState")) return "complete";
    if (source.includes("document.body?.innerText")) return this.visibleText;
    if (source.includes("document.querySelectorAll(\"input, textarea")) return { inputs: [], buttons: [] };
    return this.visibleText;
  }

  locator() {
    const page = this;
    return {
      nth(index) {
        return {
          async click() {
            if (page.clickError) throw new Error(page.clickError);
            page.clicked += 1;
            if (page.clickChangesText) page.visibleText = `${page.visibleText} clicked`;
          },
          async hover() { page.hovered += 1; },
          async fill(value) { page.value = value; },
          async evaluate(callback) {
            const target = {
              isContentEditable: true,
              innerText: page.value,
              textContent: page.value,
            };

            const previousInput = globalThis.HTMLInputElement;
            const previousTextarea = globalThis.HTMLTextAreaElement;

            class FakeInputElement {}
            class FakeTextAreaElement {}

            globalThis.HTMLInputElement = FakeInputElement;
            globalThis.HTMLTextAreaElement = FakeTextAreaElement;

            try {
              return callback(target);
            } finally {
              if (previousInput === undefined) delete globalThis.HTMLInputElement;
              else globalThis.HTMLInputElement = previousInput;

              if (previousTextarea === undefined) delete globalThis.HTMLTextAreaElement;
              else globalThis.HTMLTextAreaElement = previousTextarea;
            }
          },
        };
      },
    };
  }

  waitForEvent(name) {
    if (name === "filechooser") {
      return Promise.resolve({ setFiles: async (files) => { this.uploaded = [...files]; } });
    }
    if (name === "download") {
      if (this.downloadError) return Promise.reject(this.downloadError);
      const page = this;
      return Promise.resolve({
        suggestedFilename: () => page.suggestedDownloadName,
        saveAs: async (destination) => writeFile(destination, page.downloadBytes),
      });
    }
    throw new Error(`Unexpected event ${name}`);
  }
}

function matchesQuery(element, query) {
  const match = (value, expected, exact = false) => {
    if (expected === undefined) return true;
    if (expected && typeof expected === "object") return new RegExp(expected.source, expected.flags).test(value);
    return exact ? value === expected : value.toLowerCase().includes(expected.toLowerCase());
  };
  if ((query.visible ?? true) && !element.visible) return false;
  if (query.role && query.role !== element.role) return false;
  if (query.contenteditable !== undefined && query.contenteditable !== element.contenteditable) return false;
  if (!match(element.accessibleName, query.name, query.exact ?? false)) return false;
  if (!match(element.text, query.text, query.exact ?? false)) return false;
  if (!match(element.href ?? "", query.href, query.exact ?? false)) return false;
  const enabledOnly = query.enabled ?? !query.includeDisabled;
  if (enabledOnly && element.disabled) return false;
  if (query.enabled === false && !element.disabled) return false;
  return true;
}

function makeConnection(pages) {
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = new FakePage();
      pages.push(page);
      return page;
    },
  };
  const browser = {
    contexts: () => [context],
    isConnected: () => true,
    close: async () => { browser.closed = true; },
    closed: false,
  };
  return { browser, context };
}

function gatewayFor(pages, endpoint = "http://user:password@127.0.0.1:9222/devtools/?token=secret") {
  const connection = makeConnection(pages);
  const gateway = new CdpBrowserGateway({ endpoint }, {
    connectOverCDP: async (receivedEndpoint) => {
      assert.equal(receivedEndpoint, endpoint);
      return connection.browser;
    },
  });
  return { gateway, connection };
}

test("connects to a fake CDP transport, creates opaque tab ids, and selects the requested tab", async () => {
  const first = new FakePage("https://example.test/one", "first page");
  const second = new FakePage("https://example.test/two", "second page");
  const { gateway } = gatewayFor([first, second]);
  await gateway.connect();
  const tabs = await gateway.tabs();
  assert.equal(tabs.length, 2);
  assert.notEqual(tabs[0].id, tabs[1].id);
  assert.match(gateway.sessionId, /^cdp-[a-f0-9]{16}$/);
  assert.equal(gateway.sessionId.includes("password"), false);
  assert.equal(gateway.sessionId.includes("secret"), false);

  await gateway.selectTab(tabs[1].id);
  const observation = await gateway.observe();
  assert.equal(observation.url, "https://example.test/two");
  assert.equal(observation.visibleText, "second page");
  await assert.rejects(() => gateway.selectTab("unknown-tab"), /no longer available/);
});

test("semantic resolution and click report dispatch separately from page-state verification", async () => {
  const page = new FakePage("https://example.test", "before");
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  const query = { role: "button", name: "Continue" };
  const match = await gateway.resolve(query);
  assert.equal(match.matched, true);
  const result = await gateway.click(query, 0);
  assert.equal(result.matched, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.verified, false);
  assert.equal(result.timedOut, true);
  assert.equal(page.clicked, 1);

  page.clickError = "Browser rejected a click while prompt=private-user-content token=private-token-value";
  const failedClick = await gateway.click(query, 100);
  assert.equal(failedClick.dispatched, false);
  assert.equal(failedClick.error, "Browser operation failed.");
  assert.equal(failedClick.error.includes("private-user-content"), false);
  assert.equal(failedClick.error.includes("private-token-value"), false);
  page.clickError = null;

  page.elements.push({ ...page.elements[0] });
  const ambiguous = await gateway.click(query, 0);
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.dispatched, false);
  assert.match(ambiguous.error, /not unique/);
  assert.equal(page.clicked, 1);
});

test("disabled controls are excluded by default and can be included for safe UI-state inspection", async () => {
  const page = new FakePage();
  page.elements.push({
    ...page.elements[0],
    accessibleName: "Generate",
    text: "Generate",
    disabled: false,
  });
  page.elements.push({
    ...page.elements[0],
    accessibleName: "Generate",
    text: "Generate",
    disabled: true,
  });
  const { gateway } = gatewayFor([page]);
  await gateway.connect();

  const ordinary = await gateway.resolve({ role: "button", name: "Generate" });
  assert.equal(ordinary.matched, true);
  assert.equal(ordinary.count, 1, "default resolution matches enabled controls only");
  const inspected = await gateway.resolve({ role: "button", name: "Generate", includeDisabled: true });
  assert.equal(inspected.matched, false);
  assert.equal(inspected.count, 2, "state inspection includes both enabled and disabled controls");
  const disabledOnly = await gateway.resolve({ role: "button", name: "Generate", enabled: false });
  assert.equal(disabledOnly.matched, true);
  assert.equal(disabledOnly.element.disabled, true);
});

test("waitFor polls a semantic query until it becomes unique and reports no match on timeout", async () => {
  const page = new FakePage();
  page.elements.push({
    ...page.elements[0],
    accessibleName: "Generate",
    text: "Generate",
    disabled: true,
    visible: false,
  });
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  const query = { role: "button", name: "Generate" };

  assert.equal((await gateway.resolve(query)).matched, false);
  let polls = 0;
  page.waitForTimeout = async () => {
    polls += 1;
    if (polls === 2) page.elements[2] = { ...page.elements[2], visible: true, disabled: false };
  };
  const appeared = await gateway.waitFor(query, 5_000);
  assert.equal(appeared.matched, true);
  assert.ok(polls >= 2, "waitFor must poll while the control is not yet observable");

  const missing = await gateway.waitFor({ role: "button", name: "Not present" }, 0);
  assert.equal(missing.matched, false);
  assert.equal(missing.count, 0);
});

test("DOM diagnostics omit prompt, password, labels, values, page text, and raw markup", async () => {
  const page = new FakePage();
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const prompt = "A private prompt that must not appear in diagnostics";
  const password = "private-password-value";
  const element = (tagName, attributes = {}) => ({
    tagName,
    getAttribute(name) { return attributes[name] ?? null; },
    value: password,
    innerText: prompt,
    outerHTML: `<${tagName} aria-label="${prompt}">${password}</${tagName}>`,
    parentElement: { innerText: prompt },
  });
  const input = element("div", { role: "textbox", "aria-label": prompt, placeholder: prompt, name: password, contenteditable: "true" });
  const button = element("button", { role: "button", "aria-label": prompt });
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === "button" ? [button] : [input];
    },
  };

  try {
    const diagnostics = await gateway.domDiagnostics();
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(prompt), false);
    assert.equal(serialized.includes(password), false);
    assert.deepEqual(diagnostics.inputs[0], {
      tagName: "div", role: "textbox", ariaLabel: null, placeholder: null, name: null, type: null,
      contenteditable: "true", value: null, text: "", parentText: "", html: "<div [attributes/content redacted]>",
    });
    assert.deepEqual(diagnostics.buttons[0], {
      tagName: "button", role: "button", ariaLabel: null, placeholder: null, name: null, type: null,
      contenteditable: null, value: null, text: "", parentText: "", html: "<button [attributes/content redacted]>",
    });
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
});

test("semantic discovery omits contenteditable prompt text from element names and text fields", async () => {
  const page = new FakePage();
  page.executePageCallbacks = true;
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  const prompt = "A private contenteditable prompt";
  const field = {
    tagName: "DIV",
    isContentEditable: true,
    innerText: prompt,
    getAttribute(name) { return name === "contenteditable" ? "true" : null; },
    getBoundingClientRect() { return { width: 240, height: 48 }; },
  };
  const globalNames = ["document", "window", "HTMLInputElement", "HTMLTextAreaElement", "HTMLOptionElement"];
  const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.document = { readyState: "complete", querySelectorAll: () => [field] };
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  globalThis.HTMLInputElement = class HTMLInputElement {};
  globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};
  globalThis.HTMLOptionElement = class HTMLOptionElement {};

  try {
    const discovery = await gateway.discoverPage();
    assert.equal(discovery.elements[0].text, "");
    assert.equal(discovery.elements[0].accessibleName, "");
    assert.equal(JSON.stringify(discovery).includes(prompt), false);
    const resolved = await gateway.resolve({ role: "textbox", contenteditable: true });
    assert.equal(resolved.matched, true);
    assert.equal(resolved.element.text, "");
    assert.equal(resolved.element.accessibleName, "");
    assert.equal(JSON.stringify(resolved).includes(prompt), false);
  } finally {
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("fill uses a before-value guard and read-back verification; hover uses the unique semantic target", async () => {
  const page = new FakePage("https://example.test");
  page.value = "user text";
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  const query = { role: "textbox", contenteditable: true };

  const guarded = await gateway.fill(query, "replacement", 100, { expectedBeforeValue: "" });
  assert.equal(guarded.verified, false);
  assert.equal(page.value, "user text", "guard must prevent overwriting text that changed after inspection");

  const filled = await gateway.fill(query, "replacement", 100, { expectedBeforeValue: "user text" });
  assert.equal(filled.verified, true);
  assert.equal(filled.beforeLength, "user text".length);
  assert.equal(filled.afterLength, "replacement".length);
  assert.equal("beforeValue" in filled, false, "fill results must not expose editable text");
  assert.equal("afterValue" in filled, false, "fill results must not expose editable text");
  assert.equal(await gateway.hover({ role: "button", name: "Continue" }), true);
  assert.equal(page.hovered, 1);
});

test("fill treats whitespace-only contenteditable text as an empty before-value", async () => {
  const page = new FakePage("https://example.test");
  page.value = "\n";
  const { gateway } = gatewayFor([page]);
  await gateway.connect();

  const query = { role: "textbox", contenteditable: true };

  const filled = await gateway.fill(
    query,
    "FLOWFORGE SAFE PROMPT TEST",
    100,
    { expectedBeforeValue: "" },
  );

  assert.equal(filled.verified, true);
  assert.equal(page.value, "FLOWFORGE SAFE PROMPT TEST");
  assert.equal(filled.beforeLength, 0);
  assert.equal(filled.afterLength, "FLOWFORGE SAFE PROMPT TEST".length);
});

test("visible file chooser upload and download events save files under the requested local directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-cdp-test-"));
  try {
    const page = new FakePage();
    const { gateway } = gatewayFor([page]);
    await gateway.connect();
    const uploadFile = path.join(directory, "reference.png");
    await writeFile(uploadFile, "reference-bytes");
    const uploaded = await gateway.upload({ role: "button", name: "Continue" }, [uploadFile], 100);
    assert.deepEqual(uploaded.fileNames, ["reference.png"]);
    assert.deepEqual(page.uploaded, [uploadFile]);

    const downloaded = await gateway.download({ role: "button", name: "Continue" }, directory, 100);
    assert.match(downloaded.fileName, /^flow-download-[0-9a-f-]+\.png$/);
    assert.equal(await readFile(downloaded.path, "utf8"), "fake-download-bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download timeouts are typed and their underlying text is not exposed", async () => {
  const page = new FakePage();
  page.downloadError = Object.assign(
    new Error("Timeout while handling private prompt contents and token=private-token"),
    { name: "TimeoutError" },
  );
  const { gateway } = gatewayFor([page]);
  await gateway.connect();
  await assert.rejects(
    () => gateway.download({ role: "button", name: "Continue" }, "/tmp", 1),
    (error) => error instanceof BrowserGatewayError && error.timedOut === true &&
      error.message === "Browser download timed out." && !error.message.includes("private-token"),
  );
});

test("navigation rejects non-web schemes and disconnect detaches the fake browser", async () => {
  const page = new FakePage();
  const { gateway, connection } = gatewayFor([page]);
  await gateway.connect();
  await assert.rejects(() => gateway.open("javascript:alert(1)"), /HTTP and HTTPS/);
  await gateway.disconnect();
  assert.equal(connection.browser.closed, true);
  assert.equal(await gateway.state(), "DISCONNECTED");
});
