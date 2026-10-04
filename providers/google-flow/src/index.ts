import type { BrowserGateway, SemanticActionResult } from "@flowforge/browser";
import type {
  GenerationProviderRequest,
  ProviderAdapter,
  ProviderArtifact,
  ProviderCapabilities,
  ProviderGenerationHandle,
  ProviderGenerationSnapshot,
} from "@flowforge/core";

/**
 * Safe adapter shell only. This Phase 1 implementation exposes the shared provider
 * contract but intentionally performs no Flow submission, monitoring, or download.
 */
export class GoogleFlowAdapter implements ProviderAdapter {
  readonly id = "google-flow";
  readonly capabilities: ProviderCapabilities = Object.freeze({
    imageGeneration: false,
    videoGeneration: false,
    referenceImages: false,
    startFrame: false,
    endFrame: false,
    batchGeneration: false,
  });

  constructor(private readonly browser: BrowserGateway) {}

  async connect(): Promise<void> {
    await this.browser.connect();
  }

  async inspectState(): Promise<Record<string, unknown>> {
    return {
      provider: this.id,
      browser: await this.browser.state(),
      tabs: await this.browser.tabs(),
    };
  }

  async preparePrompt(prompt: string): Promise<void> {
    const query = { role: "textbox", contenteditable: true } as const;
    const result = await this.browser.fill(query, prompt);
    if (!result.matched || !result.verified) {
      throw new Error(result.error ?? "Google Flow prompt editor was not uniquely resolved or verified.");
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
    if (!after.matched) return { ...result, verified: true, error: undefined };
    return result;
  }

  async findGeneration(_providerRequestKey: string): Promise<ProviderGenerationHandle | null> {
    throw new Error("Google Flow recovery is intentionally unimplemented in Phase 1.");
  }

  async createGeneration(_request: GenerationProviderRequest): Promise<ProviderGenerationHandle> {
    throw new Error("Google Flow submission is intentionally unimplemented in Phase 1.");
  }

  async getGenerationStatus(_providerJobId: string): Promise<ProviderGenerationSnapshot> {
    throw new Error("Google Flow monitoring is intentionally unimplemented in Phase 1.");
  }

  async downloadResult(_providerJobId: string): Promise<ProviderArtifact[]> {
    throw new Error("Google Flow download is intentionally unimplemented in Phase 1.");
  }

  async cancelGeneration(_providerJobId: string): Promise<void> {
    throw new Error("Google Flow cancellation is intentionally unimplemented in Phase 1.");
  }

  async disconnect(): Promise<void> {
    await this.browser.disconnect();
  }
}
