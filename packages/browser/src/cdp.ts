import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  BrowserGateway,
  BrowserState,
  DomDiagnostics,
  BrowserTab,
  PageDiscovery,
  SemanticActionResult,
  SemanticElement,
  SemanticMatch,
  SemanticQuery,
} from "./index.js";

export interface CdpBrowserGatewayOptions {
  endpoint: string;
}

export class CdpBrowserGateway implements BrowserGateway {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly options: CdpBrowserGatewayOptions) {}

  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;

    this.browser = await chromium.connectOverCDP(this.options.endpoint);
    const contexts = this.browser.contexts();

    if (contexts.length === 0) {
      throw new Error("CDP connected, but Chrome exposes no browser context.");
    }

    this.context = contexts[0];
  }

  async disconnect(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
  }

  async state(): Promise<BrowserState> {
    if (!this.browser?.isConnected() || !this.context) return "DISCONNECTED";
    return this.context.pages().length > 0 ? "CONNECTED" : "PAGE_NOT_FOUND";
  }

  async tabs(): Promise<BrowserTab[]> {
    return Promise.all(
      this.requireContext()
        .pages()
        .map(async (page, index) => ({
          id: String(index),
          url: page.url(),
          title: await page.title(),
        })),
    );
  }

  async open(url: string): Promise<void> {
    const context = this.requireContext();
    let page: Page | undefined = context.pages()[0];

    if (!page) page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async screenshot(): Promise<Uint8Array> {
    const pages = this.requireContext().pages();

    if (!pages.length) {
      throw new Error("Chrome has no open pages.");
    }

    return pages[0].screenshot({ type: "png" });
  }

  async resolve(query: SemanticQuery): Promise<SemanticMatch> {
    const pages = this.requireContext().pages();

    if (!pages.length) {
      throw new Error("Chrome has no open pages.");
    }

    const page = pages[0];

    const result = await page.evaluate((input) => {
      const clean = (value: string | null | undefined): string =>
        (value ?? "").replace(/\\s+/g, " ").trim();

      const matches = (value: string, expected: string | { source: string; flags: string } | undefined, exact: boolean): boolean => {
        if (expected === undefined) return true;

        if (typeof expected === "object") {
          return new RegExp(expected.source, expected.flags).test(value);
        }

        return exact ? value === expected : value.toLowerCase().includes(expected.toLowerCase());
      };

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            "button",
            "a[href]",
            "input",
            "textarea",
            "select",
            "[role]",
            "[aria-label]",
            "[contenteditable='true']",
          ].join(","),
        ),
      );

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) return explicitRole;

        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";

        return null;
      };

      const exact = input.exact ?? false;
      const visibleOnly = input.visible ?? true;
      const enabledOnly = input.enabled ?? true;

      const found: SemanticElement[] = [];

      for (const element of candidates) {
        const visible = isVisible(element);
        if (visibleOnly && !visible) continue;

        const tagName = element.tagName.toLowerCase();
        const role = inferRole(element);
        const text = clean(element.innerText);
        const ariaLabel = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? clean(element.value)
            : "";

        const accessibleName = ariaLabel || text || value || title;
        const href = element.getAttribute("href");
        const disabled =
          "disabled" in element &&
          Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled);

        if (input.role && role !== input.role) continue;
        if (!matches(accessibleName, input.name, exact)) continue;
        if (!matches(text, input.text, exact)) continue;
        if (!matches(href ?? "", input.href, exact)) continue;
        if (enabledOnly && disabled) continue;

        found.push({
          tagName,
          role,
          accessibleName,
          text,
          href,
          inputType:
            element instanceof HTMLInputElement ? element.type : null,
          disabled,
          visible,
        });
      }

      return {
        matched: found.length === 1,
        count: found.length,
        element: found.length === 1 ? found[0] : null,
      };
    }, {
      ...query,
      name:
        query.name instanceof RegExp
          ? { source: query.name.source, flags: query.name.flags }
          : query.name,
      text:
        query.text instanceof RegExp
          ? { source: query.text.source, flags: query.text.flags }
          : query.text,
      href:
        query.href instanceof RegExp
          ? { source: query.href.source, flags: query.href.flags }
          : query.href,
    });

    return result;
  }

  async click(query: SemanticQuery, timeoutMs = 10000): Promise<SemanticActionResult> {
    const pages = this.requireContext().pages();

    if (!pages.length) {
      throw new Error("Chrome has no open pages.");
    }

    const page = pages[0];
    const beforeUrl = page.url();
    const beforeTitle = await page.title();
    const match = await this.resolve(query);

    if (!match.matched) {
      return {
        action: "click",
        query,
        matched: false,
        verified: false,
        beforeUrl,
        afterUrl: beforeUrl,
        beforeTitle,
        afterTitle: beforeTitle,
        error: `Semantic target was not unique. Match count: ${match.count}`,
      };
    }

    const serializedQuery = {
      ...query,
      name:
        query.name instanceof RegExp
          ? { source: query.name.source, flags: query.name.flags }
          : query.name,
      text:
        query.text instanceof RegExp
          ? { source: query.text.source, flags: query.text.flags }
          : query.text,
      href:
        query.href instanceof RegExp
          ? { source: query.href.source, flags: query.href.flags }
          : query.href,
    };

    await page.evaluate((input) => {
      const clean = (value: string | null | undefined): string =>
        (value ?? "").replace(/\\s+/g, " ").trim();

      const matches = (
        value: string,
        expected: string | { source: string; flags: string } | undefined,
        exact: boolean,
      ): boolean => {
        if (expected === undefined) return true;
        if (typeof expected === "object") {
          return new RegExp(expected.source, expected.flags).test(value);
        }
        return exact
          ? value === expected
          : value.toLowerCase().includes(expected.toLowerCase());
      };

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) return explicitRole;

        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        return null;
      };

      const exact = input.exact ?? false;
      const visibleOnly = input.visible ?? true;
      const enabledOnly = input.enabled ?? true;
      const found: HTMLElement[] = [];

      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            "button",
            "a[href]",
            "input",
            "textarea",
            "select",
            "[role]",
            "[aria-label]",
            "[contenteditable='true']",
          ].join(","),
        ),
      )) {
        const visible = isVisible(element);
        if (visibleOnly && !visible) continue;

        const role = inferRole(element);
        const text = clean(element.innerText);
        const ariaLabel = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? clean(element.value)
            : "";
        const accessibleName = ariaLabel || text || value || title;
        const href = element.getAttribute("href");
        const disabled =
          "disabled" in element &&
          Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled);

        if (input.role && role !== input.role) continue;
        if (!matches(accessibleName, input.name, exact)) continue;
        if (!matches(text, input.text, exact)) continue;
        if (!matches(href ?? "", input.href, exact)) continue;
        if (enabledOnly && disabled) continue;

        found.push(element);
      }

      if (found.length !== 1) {
        throw new Error(`Semantic target was not unique. Match count: ${found.length}`);
      }

      found[0].click();
    }, serializedQuery);

    const deadline = Date.now() + timeoutMs;
    let afterUrl = page.url();
    let afterTitle = await page.title();

    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      afterUrl = page.url();
      afterTitle = await page.title();

      if (afterUrl !== beforeUrl || afterTitle !== beforeTitle) {
        return {
          action: "click",
          query,
          matched: true,
          verified: true,
          beforeUrl,
          afterUrl,
          beforeTitle,
          afterTitle,
        };
      }
    }

    return {
      action: "click",
      query,
      matched: true,
      verified: false,
      beforeUrl,
      afterUrl,
      beforeTitle,
      afterTitle,
      error: "Click dispatched, but no observable URL/title change occurred before timeout.",
    };
  }

  async domDiagnostics(): Promise<DomDiagnostics> {
    const pages = this.requireContext().pages();

    if (!pages.length) {
      throw new Error("Chrome has no open pages.");
    }

    return pages[0].evaluate(() => {
      const clean = (value: string | null | undefined): string =>
        (value ?? "").replace(/\\s+/g, " ").trim().slice(0, 500);

      const describe = (element: Element) => {
        const html = element.outerHTML.slice(0, 1200);
        const parent = element.parentElement;
        return {
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          name: element.getAttribute("name"),
          type: element.getAttribute("type"),
          contenteditable: element.getAttribute("contenteditable"),
          value: element instanceof HTMLInputElement ? element.value : null,
          text: clean(element.textContent),
          parentText: clean(parent?.innerText),
          html,
        };
      };

      return {
        inputs: Array.from(
          document.querySelectorAll("input, textarea, [contenteditable='true']")
        ).map(describe),
        buttons: Array.from(document.querySelectorAll("button")).map(describe),
      };
    });
  }

  async discoverPage(): Promise<PageDiscovery> {
    const pages = this.requireContext().pages();

    if (!pages.length) {
      throw new Error("Chrome has no open pages.");
    }

    const page = pages[0];

    const elements = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            "button",
            "a[href]",
            "input",
            "textarea",
            "select",
            "[role]",
            "[aria-label]",
            "[contenteditable='true']",
          ].join(","),
        ),
      );

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const clean = (value: string | null | undefined, limit = 240): string => {
        return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
      };

      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) return explicitRole;

        const tag = element.tagName.toLowerCase();

        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input") return "textbox";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";

        return null;
      };

      const elements: SemanticElement[] = [];

      for (const element of candidates) {
        if (!isVisible(element)) continue;

        const tagName = element.tagName.toLowerCase();
        const role = inferRole(element);
        const ariaLabel = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const text = clean(element.innerText);
        const value =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
            ? clean(element.value)
            : "";

        const accessibleName = ariaLabel || text || value || title;

        if (!accessibleName && !role && !element.getAttribute("href")) {
          continue;
        }

        elements.push({
          tagName,
          role,
          accessibleName,
          text,
          href: element.getAttribute("href"),
          inputType:
            element instanceof HTMLInputElement
              ? element.type
              : null,
          disabled:
            "disabled" in element &&
            Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
          visible: true,
        });
      }

      return elements;
    });

    return {
      url: page.url(),
      title: await page.title(),
      readyState: await page.evaluate(() => document.readyState),
      elements,
    };
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Browser Gateway is not connected to Chrome via CDP.");
    }

    return this.context;
  }
}
