import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BrowserGatewayError } from "./errors.js";
import type {
  BrowserGateway,
  BrowserState,
  BrowserTab,
  DomDiagnostics,
  PageDiscovery,
  PageObservation,
  SemanticActionResult,
  SemanticElement,
  SemanticInputResult,
  SemanticMatch,
  SemanticQuery,
  NetworkDiagnosticsHandle,
  NetworkDiagnosticsOptions,
} from "./index.js";
import { startNetworkDiagnostics } from "./cdp-network.js";

export interface CdpBrowserGatewayOptions {
  endpoint: string;
}

/** Optional transport seam for deterministic CDP adapter tests; production uses Chromium. */
export interface CdpBrowserGatewayDependencies {
  connectOverCDP?: (endpoint: string) => Promise<Browser>;
}

type SerializedExpectation = string | { source: string; flags: string };
type SerializedSemanticQuery = Omit<SemanticQuery, "name" | "text" | "href"> & {
  name?: SerializedExpectation;
  text?: SerializedExpectation;
  href?: SerializedExpectation;
};

const CANDIDATE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "img[alt]",
  "video",
  "[role]",
  "[aria-label]",
  "[title]",
  "[contenteditable='true']",
].join(",");

function serializeQuery(query: SemanticQuery): SerializedSemanticQuery {
  const serialize = (value: string | RegExp | undefined): SerializedExpectation | undefined =>
    value instanceof RegExp ? { source: value.source, flags: value.flags } : value;

  return {
    ...query,
    name: serialize(query.name),
    text: serialize(query.text),
    href: serialize(query.href),
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (/timeout/i.test(error.name) || /\b(?:timed out|timeout)\b/i.test(error.message));
}

function safeError(error: unknown): string {
  // Playwright errors can echo selectors, input values, or URLs; expose only a safe category.
  return isTimeoutError(error) ? "Browser operation timed out." : "Browser operation failed.";
}

function redactDiagnosticText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted-token]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, "[redacted-token]")
    .replace(/\b(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(password|token|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : "";
}

export class CdpBrowserGateway implements BrowserGateway {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private selectedTabId: string | null = null;
  private readonly tabIds = new WeakMap<Page, string>();
  private readonly connectOverCDP: (endpoint: string) => Promise<Browser>;
  private nextTabId = 1;
  readonly sessionId: string;

  constructor(
    private readonly options: CdpBrowserGatewayOptions,
    dependencies: CdpBrowserGatewayDependencies = {},
  ) {
    this.connectOverCDP = dependencies.connectOverCDP ?? ((endpoint) => chromium.connectOverCDP(endpoint));
    let endpointOrigin = "unknown-endpoint";
    try {
      // Use only the origin: a CDP URL may contain a private path or credentials.
      endpointOrigin = new URL(options.endpoint).origin;
    } catch {
      // connectOverCDP will report an invalid endpoint without echoing it here.
    }
    this.sessionId = `cdp-${createHash("sha256").update(endpointOrigin).digest("hex").slice(0, 16)}`;
  }

  async connect(): Promise<void> {
    if (this.browser?.isConnected() && this.context) {
      this.selectInitialPage();
      return;
    }

    this.browser = await this.connectOverCDP(this.options.endpoint);
    const contexts = this.browser.contexts();
    if (contexts.length === 0) {
      throw new Error("CDP connected, but Chrome exposes no browser context.");
    }

    this.context = contexts[0] ?? null;
    this.selectedTabId = null;
    this.selectInitialPage();
  }

  async disconnect(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.selectedTabId = null;
  }

  async startNetworkDiagnostics(
    options: NetworkDiagnosticsOptions = {},
  ): Promise<NetworkDiagnosticsHandle> {
    return startNetworkDiagnostics(this.activePage(), options);
  }

  async state(): Promise<BrowserState> {
    if (!this.browser?.isConnected() || !this.context) return "DISCONNECTED";
    return this.context.pages().length > 0 ? "CONNECTED" : "PAGE_NOT_FOUND";
  }

  async tabs(): Promise<BrowserTab[]> {
    return Promise.all(
      this.requireContext()
        .pages()
        .map(async (page) => ({
          id: this.idFor(page),
          url: safeUrl(page.url()) ?? "[unavailable]",
          title: redactDiagnosticText(await page.title()),
        })),
    );
  }

  async selectTab(tabId: string): Promise<void> {
    const page = this.requireContext().pages().find((candidate) => this.idFor(candidate) === tabId);
    if (!page) throw new Error("The requested browser tab is no longer available.");
    this.selectedTabId = this.idFor(page);
  }

  async open(url: string, options: { newTab?: boolean } = {}): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Browser navigation is restricted to HTTP and HTTPS pages.");
    }

    const context = this.requireContext();
    let page: Page;
    if (options.newTab || context.pages().length === 0) {
      page = await context.newPage();
      this.selectedTabId = this.idFor(page);
    } else {
      page = this.activePage();
    }
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
  }

  async screenshot(): Promise<Uint8Array> {
    return this.activePage().screenshot({ type: "png" });
  }

  async discoverPage(): Promise<PageDiscovery> {
    const page = this.activePage();
    const elements = await page.evaluate((selector) => {
      const clean = (value: string | null | undefined, limit = 240): string =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
          rect.width > 0 && rect.height > 0;
      };
      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) return explicitRole;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea" || element.isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "img") return "img";
        if (tag === "video") return "video";
        return null;
      };
      const selectedState = (element: HTMLElement): boolean | null => {
        const attributes = ["aria-pressed", "aria-selected", "aria-checked"];
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          if (value === "true") return true;
          if (value === "false") return false;
        }
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
          return element.checked;
        }
        if (element instanceof HTMLOptionElement) return element.selected;
        return null;
      };
      const result: SemanticElement[] = [];
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (!isVisible(element)) continue;
        const tagName = element.tagName.toLowerCase();
        const role = inferRole(element);
        const ariaLabel = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const alt = clean(element.getAttribute("alt"));
        // Do not expose live editable contents through semantic discovery or diagnostics.
        const editableText = element.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        const text = editableText ? "" : clean(element.innerText);
        const accessibleName = ariaLabel || alt || text || title;
        const href = element.getAttribute("href");
        if (!accessibleName && !role && !href) continue;
        const disabled = ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) ||
          element.getAttribute("aria-disabled") === "true";
        result.push({
          tagName,
          role,
          accessibleName,
          text,
          href,
          inputType: element instanceof HTMLInputElement ? element.type : null,
          contenteditable: element.isContentEditable,
          disabled,
          visible: true,
          selected: selectedState(element),
        });
      }
      return result;
    }, CANDIDATE_SELECTOR);

    return {
      url: safeUrl(page.url()) ?? "[unavailable]",
      title: redactDiagnosticText(await page.title()),
      readyState: await page.evaluate(() => document.readyState),
      elements,
    };
  }

  async observe(): Promise<PageObservation> {
    const page = this.activePage();
    const discovery = await this.discoverPage();
    const visibleText = await page.evaluate(() =>
      (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 32_768),
    );
    return { ...discovery, visibleText };
  }

  async domDiagnostics(): Promise<DomDiagnostics> {
    return this.activePage().evaluate(() => {
      const describe = (element: Element) => {
        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        const type = element.getAttribute("type");
        return {
          tagName,
          role,
          ariaLabel: null,
          placeholder: null,
          name: null,
          type,
          contenteditable: element.getAttribute("contenteditable"),
          // Never return live form values, page text, or raw HTML from diagnostic inspection.
          value: null,
          text: "",
          parentText: "",
          html: `<${tagName} [attributes/content redacted]>`,
        };
      };
      return {
        inputs: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).map(describe),
        buttons: Array.from(document.querySelectorAll("button")).map(describe),
      };
    });
  }

  async resolve(query: SemanticQuery): Promise<SemanticMatch> {
    return (await this.findUnique(this.activePage(), query)).match;
  }

  async waitFor(query: SemanticQuery, timeoutMs = 10_000): Promise<SemanticMatch> {
    const page = this.activePage();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const match = (await this.findUnique(page, query)).match;
      if (match.matched || Date.now() >= deadline) return match;
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  async click(query: SemanticQuery, timeoutMs = 10_000): Promise<SemanticActionResult> {
    const page = this.activePage();
    const beforeUrlRaw = page.url();
    const beforeUrl = safeUrl(beforeUrlRaw) ?? "[unavailable]";
    const beforeTitle = redactDiagnosticText(await page.title());
    const beforeText = await this.visibleText(page);
    const found = await this.findUnique(page, query);

    if (!found.match.matched || found.index === null) {
      return {
        action: "click",
        query,
        matched: false,
        dispatched: false,
        verified: false,
        beforeUrl,
        afterUrl: beforeUrl,
        beforeTitle,
        afterTitle: beforeTitle,
        error: `Semantic target was not unique. Match count: ${found.match.count}`,
      };
    }

    try {
      await page.locator(CANDIDATE_SELECTOR).nth(found.index).click({ timeout: Math.max(1, timeoutMs) });
    } catch (error) {
      return {
        action: "click",
        query,
        matched: true,
        dispatched: false,
        verified: false,
        timedOut: isTimeoutError(error),
        beforeUrl,
        afterUrl: safeUrl(page.url()) ?? "[unavailable]",
        beforeTitle,
        afterTitle: await page.title().then(redactDiagnosticText).catch(() => beforeTitle),
        error: safeError(error),
      };
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let afterUrlRaw = page.url();
    let afterUrl = safeUrl(afterUrlRaw) ?? "[unavailable]";
    let afterTitle = await page.title().then(redactDiagnosticText).catch(() => beforeTitle);
    let afterText = await this.visibleText(page).catch(() => beforeText);
    while (Date.now() < deadline) {
      if (afterUrlRaw !== beforeUrlRaw || afterTitle !== beforeTitle || afterText !== beforeText) {
        return {
          action: "click",
          query,
          matched: true,
          dispatched: true,
          verified: true,
          beforeUrl,
          afterUrl,
          beforeTitle,
          afterTitle,
        };
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      afterUrlRaw = page.url();
      afterUrl = safeUrl(afterUrlRaw) ?? "[unavailable]";
      afterTitle = await page.title().then(redactDiagnosticText).catch(() => beforeTitle);
      afterText = await this.visibleText(page).catch(() => beforeText);
    }

    return {
      action: "click",
      query,
      matched: true,
      dispatched: true,
      verified: false,
      timedOut: true,
      beforeUrl,
      afterUrl,
      beforeTitle,
      afterTitle,
      error: "Click was dispatched, but no visible page-state change was observed before timeout.",
    };
  }

  async hover(query: SemanticQuery, timeoutMs = 5_000): Promise<boolean> {
    const page = this.activePage();
    const found = await this.findUnique(page, query);
    if (!found.match.matched || found.index === null) return false;
    try {
      await page.locator(CANDIDATE_SELECTOR).nth(found.index).hover({ timeout: Math.max(1, timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }

  async fill(
    query: SemanticQuery,
    value: string,
    timeoutMs = 5_000,
    options: { expectedBeforeValue?: string } = {},
  ): Promise<SemanticInputResult> {
    const page = this.activePage();
    const found = await this.findUnique(page, query);
    if (!found.match.matched || found.index === null) {
      return {
        action: "fill",
        query,
        matched: false,
        verified: false,
        beforeLength: 0,
        afterLength: 0,
        error: `Semantic target was not unique. Match count: ${found.match.count}`,
      };
    }

    const locator = page.locator(CANDIDATE_SELECTOR).nth(found.index);
    const beforeValue = await locator.evaluate((element) => {
      const target = element as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value;
      if (target.isContentEditable) {
        const text = target.innerText;
        return text.trim() === "" ? "" : text;
      }
      return target.textContent ?? "";
    });
    if (options.expectedBeforeValue !== undefined && beforeValue !== options.expectedBeforeValue) {
      return {
        action: "fill",
        query,
        matched: true,
        verified: false,
        beforeLength: beforeValue.length,
        afterLength: beforeValue.length,
        error: "Input value changed before fill; no text was sent.",
      };
    }
    try {
      await locator.fill(value, { timeout: Math.max(1, timeoutMs) });
    } catch (error) {
      return {
        action: "fill",
        query,
        matched: true,
        verified: false,
        timedOut: isTimeoutError(error),
        beforeLength: beforeValue.length,
        afterLength: beforeValue.length,
        error: safeError(error),
      };
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let afterValue = beforeValue;
    do {
      afterValue = await locator.evaluate((element) => {
        const target = element as HTMLElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value;
        if (target.isContentEditable) {
          const text = target.innerText;
          return text.trim() === "" ? "" : text;
        }
        return target.textContent ?? "";
      }).catch(() => afterValue);
      if (afterValue === value) {
        return {
          action: "fill",
          query,
          matched: true,
          verified: true,
          beforeLength: beforeValue.length,
          afterLength: afterValue.length,
        };
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);

    return {
      action: "fill",
      query,
      matched: true,
      verified: false,
      beforeLength: beforeValue.length,
      afterLength: afterValue.length,
      timedOut: true,
      error: `Fill was dispatched but read-back did not match the requested value (expected length ${value.length}, actual length ${afterValue.length}).`,
    };
  }

  async upload(trigger: SemanticQuery, filePaths: string[], timeoutMs = 30_000): Promise<{ fileNames: string[] }> {
    if (filePaths.length === 0) throw new Error("At least one local file is required for upload.");
    const absolutePaths = filePaths.map((filePath) => path.resolve(filePath));
    for (const filePath of absolutePaths) {
      if (!(await stat(filePath)).isFile()) throw new Error("Every upload path must identify a local file.");
    }

    const page = this.activePage();
    const found = await this.findUnique(page, trigger);
    if (!found.match.matched || found.index === null) {
      throw new Error(`Upload trigger was not unique. Match count: ${found.match.count}`);
    }

    const chooserEvent = page.waitForEvent("filechooser", { timeout: Math.max(1, timeoutMs) });
    try {
      await page.locator(CANDIDATE_SELECTOR).nth(found.index).click({ timeout: Math.max(1, timeoutMs) });
      const chooser = await chooserEvent;
      await chooser.setFiles(absolutePaths);
      return { fileNames: absolutePaths.map((filePath) => path.basename(filePath)) };
    } catch (error) {
      await chooserEvent.catch(() => undefined);
      throw new BrowserGatewayError(
        isTimeoutError(error) ? "Browser upload timed out." : "Browser upload failed.",
        { timedOut: isTimeoutError(error) },
      );
    }
  }

  async download(query: SemanticQuery, destinationDirectory: string, timeoutMs = 30_000): Promise<{ path: string; fileName: string }> {
    const page = this.activePage();
    const found = await this.findUnique(page, query);
    if (!found.match.matched || found.index === null) {
      throw new Error(`Download control was not unique. Match count: ${found.match.count}`);
    }

    const downloadEvent = page.waitForEvent("download", { timeout: Math.max(1, timeoutMs) });
    try {
      await page.locator(CANDIDATE_SELECTOR).nth(found.index).click({ timeout: Math.max(1, timeoutMs) });
      const download = await downloadEvent;
      const extension = safeExtension(download.suggestedFilename());
      const fileName = `flow-download-${randomUUID()}${extension}`;
      const directory = path.resolve(destinationDirectory);
      await mkdir(directory, { recursive: true });
      const downloadPath = path.join(directory, fileName);
      await download.saveAs(downloadPath);
      return { path: downloadPath, fileName };
    } catch (error) {
      await downloadEvent.catch(() => undefined);
      throw new BrowserGatewayError(
        isTimeoutError(error) ? "Browser download timed out." : "Browser download failed.",
        { timedOut: isTimeoutError(error) },
      );
    }
  }

  private async findUnique(page: Page, query: SemanticQuery): Promise<{ match: SemanticMatch; index: number | null }> {
    return page.evaluate(({ selector, query: input }) => {
      const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
      const matches = (
        value: string,
        expected: SerializedExpectation | undefined,
        exact: boolean,
      ): boolean => {
        if (expected === undefined) return true;
        if (typeof expected === "object") return new RegExp(expected.source, expected.flags).test(value);
        return exact ? value === expected : value.toLowerCase().includes(expected.toLowerCase());
      };
      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
          rect.width > 0 && rect.height > 0;
      };
      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) return explicitRole;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea" || element.isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "img") return "img";
        if (tag === "video") return "video";
        return null;
      };
      const selectedState = (element: HTMLElement): boolean | null => {
        for (const attribute of ["aria-pressed", "aria-selected", "aria-checked"]) {
          const value = element.getAttribute(attribute);
          if (value === "true") return true;
          if (value === "false") return false;
        }
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return element.checked;
        if (element instanceof HTMLOptionElement) return element.selected;
        return null;
      };
      const result: SemanticElement[] = [];
      const indexes: number[] = [];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
      candidates.forEach((element, index) => {
        const visible = isVisible(element);
        if ((input.visible ?? true) && !visible) return;
        const tagName = element.tagName.toLowerCase();
        const role = inferRole(element);
        const ariaLabel = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const alt = clean(element.getAttribute("alt"));
        // Do not expose live editable contents through semantic discovery or diagnostics.
        const editableText = element.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        const text = editableText ? "" : clean(element.innerText);
        const accessibleName = ariaLabel || alt || text || title;
        const href = element.getAttribute("href");
        const disabled = ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) ||
          element.getAttribute("aria-disabled") === "true";
        if (input.role && role !== input.role) return;
        if (input.contenteditable !== undefined && element.isContentEditable !== input.contenteditable) return;
        if (!matches(accessibleName, input.name, input.exact ?? false)) return;
        if (!matches(text, input.text, input.exact ?? false)) return;
        if (!matches(href ?? "", input.href, input.exact ?? false)) return;
        const enabledOnly = input.enabled ?? !input.includeDisabled;
        if (enabledOnly && disabled) return;
        if (input.enabled === false && !disabled) return;
        indexes.push(index);
        result.push({
          tagName,
          role,
          accessibleName,
          text,
          href,
          inputType: element instanceof HTMLInputElement ? element.type : null,
          contenteditable: element.isContentEditable,
          disabled,
          visible,
          selected: selectedState(element),
        });
      });
      return {
        match: {
          matched: result.length === 1,
          count: result.length,
          element: result.length === 1 ? result[0] : null,
        },
        index: result.length === 1 ? indexes[0] ?? null : null,
      };
    }, { selector: CANDIDATE_SELECTOR, query: serializeQuery(query) });
  }

  private async visibleText(page: Page): Promise<string> {
    return page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 4_096));
  }

  private selectInitialPage(): void {
    if (!this.context || this.selectedTabId) return;
    const firstPage = this.context.pages()[0];
    if (firstPage) this.selectedTabId = this.idFor(firstPage);
  }

  private idFor(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) {
      id = `tab-${this.nextTabId++}`;
      this.tabIds.set(page, id);
    }
    return id;
  }

  private activePage(): Page {
    const pages = this.requireContext().pages();
    if (pages.length === 0) throw new Error("Chrome has no open pages.");
    this.selectInitialPage();
    const selected = pages.find((page) => this.idFor(page) === this.selectedTabId);
    if (selected) return selected;
    if (pages.length === 1) {
      this.selectedTabId = this.idFor(pages[0]!);
      return pages[0]!;
    }
    throw new Error("The selected browser tab is no longer available; select a tab before continuing.");
  }

  private requireContext(): BrowserContext {
    if (!this.context || !this.browser?.isConnected()) {
      throw new Error("Browser Gateway is not connected to Chrome via CDP.");
    }
    return this.context;
  }
}
