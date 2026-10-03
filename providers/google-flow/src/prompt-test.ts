import { CdpBrowserGateway } from "@flowforge/browser";
import { GoogleFlowAdapter } from "./index.js";

const endpoint =
  process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

const testPrompt =
  "FLOWFORGE PROMPT PREPARATION TEST — DO NOT GENERATE";

async function main(): Promise<void> {
  const browser = new CdpBrowserGateway({ endpoint });
  const adapter = new GoogleFlowAdapter(browser);

  await adapter.connect();

  try {
    console.log("[FlowForge] Provider state:");
    console.log(JSON.stringify(await adapter.inspectState(), null, 2));

    await adapter.preparePrompt(testPrompt);
    console.log("[FlowForge] Prompt preparation verified.");

    await adapter.clearPrompt();
    console.log("[FlowForge] Prompt cleared and verified.");

    const generate = await adapter.discoverGenerate();

    console.log("[FlowForge] Generate discovery:");
    console.log(JSON.stringify(generate, null, 2));

    if (!generate.matched) {
      throw new Error(
        `Generate control was not uniquely discovered. Match count: ${generate.count}`,
      );
    }

    console.log("[FlowForge] Generate control discovered semantically.");
    console.log("[FlowForge] No Generate action was dispatched.");
    console.log("[FlowForge] Safe Google Flow discovery test passed.");
  } finally {
    await adapter.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Safe Google Flow discovery test failed:", error);
  process.exitCode = 1;
});
