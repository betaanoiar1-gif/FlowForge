import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BrowserGateway, BrowserState, BrowserTab } from "./index.js";

export interface CdpBrowserGatewayOptions { endpoint: string; }

export class CdpBrowserGateway implements BrowserGateway {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly options: CdpBrowserGatewayOptions) {}

  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;
    this.browser = await chromium.connectOverCDP(this.options.endpoint);
    const contexts = this.browser.contexts();
    if (contexts.length === 0) throw new Error("CDP connected, but Chrome exposes no browser context.");
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
    return this.requireContext().pages().map((page, index) => ({id:String(index), url:page.url(), title:""}));
  }

  async open(url: string): Promise<void> {
    const context = this.requireContext();
    let page: Page | undefined = context.pages()[0];
    if (!page) page = await context.newPage();
    await page.goto(url, {waitUntil:"domcontentloaded"});
  }

  async screenshot(): Promise<Uint8Array> {
    const pages = this.requireContext().pages();
    if (!pages.length) throw new Error("Chrome has no open pages.");
    return pages[0].screenshot({type:"png"});
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error("Browser Gateway is not connected to Chrome via CDP.");
    return this.context;
  }
}
