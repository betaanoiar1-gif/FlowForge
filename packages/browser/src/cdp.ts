import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  BrowserGateway,
  BrowserState,
  BrowserTab,
  PageDiscovery,
  SemanticElement,
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
