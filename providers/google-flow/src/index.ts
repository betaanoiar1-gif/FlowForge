import type { BrowserGateway } from "@flowforge/browser";
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
