import type { BrowserGateway, SemanticActionResult } from "@flowforge/browser";
import type {
  GenerationRequest,
  GenerationResult,
  ProviderAdapter
} from "@flowforge/core";

export class GoogleFlowAdapter implements ProviderAdapter {
  readonly id = "google-flow";

  constructor(private readonly browser: BrowserGateway) {}

  async connect(): Promise<void> {
    await this.browser.connect();
  }

  async inspectState(): Promise<Record<string, unknown>> {
    return {
      provider: this.id,
      browser: await this.browser.state(),
      tabs: await this.browser.tabs()
    };
  }

  async preparePrompt(prompt: string): Promise<void> {
    const query = {
      role: "textbox",
      contenteditable: true,
    } as const;

    const result = await this.browser.fill(query, prompt);

    if (!result.matched || !result.verified) {
      throw new Error(
        result.error ??
          "Google Flow prompt editor was not uniquely resolved or verified."
      );
    }
  }

  async clearPrompt(): Promise<void> {
    await this.preparePrompt("");
  }

  private generateQuery() {
    return {
      role: "button",
      name: /construction begins/i,
      visible: true,
      enabled: true,
    } as const;
  }

  async discoverGenerate(): Promise<Awaited<ReturnType<BrowserGateway["resolve"]>>> {
    return this.browser.resolve(this.generateQuery());
  }

  async clickGenerate(timeoutMs = 2000): Promise<SemanticActionResult> {
    const query = this.generateQuery();
    const result = await this.browser.click(query, timeoutMs);

    if (result.verified) return result;

    const after = await this.browser.resolve(query);

    if (!after.matched) {
      return {
        ...result,
        verified: true,
        error: undefined,
      };
    }

    return result;
  }

  async submit(_request: GenerationRequest): Promise<{ externalId?: string }> {
    throw new Error(
      "Google Flow submission is intentionally not implemented until the CDP browser gateway is validated."
    );
  }

  async waitForCompletion(_externalId: string): Promise<GenerationResult> {
    throw new Error("Google Flow generation polling is not implemented yet.");
  }

  async download(_result: GenerationResult): Promise<string[]> {
    throw new Error("Google Flow download handling is not implemented yet.");
  }

  async disconnect(): Promise<void> {
    await this.browser.disconnect();
  }
}
