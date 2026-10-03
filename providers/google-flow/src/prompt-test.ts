import { CdpBrowserGateway } from "@flowforge/browser";
import { GoogleFlowAdapter } from "./index.js";

const endpoint =
  process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

const testPrompt =
  "FLOWFORGE PROMPT DISCOVERY TEST — DO NOT GENERATE";

async function main(): Promise<void> {
  const browser = new CdpBrowserGateway({ endpoint });
  const adapter = new GoogleFlowAdapter(browser);

  await adapter.connect();

  try {
    console.log("[FlowForge] Provider state:");
    console.log(JSON.stringify(await adapter.inspectState(), null, 2));

    const initialGenerate = await adapter.discoverGenerate();

    console.log("[FlowForge] Initial Generate discovery (empty prompt):");
    console.log(JSON.stringify(initialGenerate, null, 2));

    if (initialGenerate.matched) {
      throw new Error(
        "Generate control unexpectedly matched while the prompt was empty.",
      );
    }

    await adapter.preparePrompt(testPrompt);
    console.log("[FlowForge] Test prompt preparation verified.");

    const enabledGenerate = await adapter.discoverGenerate();

    console.log("[FlowForge] Generate discovery (test prompt present):");
    console.log(JSON.stringify(enabledGenerate, null, 2));

    if (!enabledGenerate.matched) {
      throw new Error(
        "Enabled Generate control was not uniquely discovered. Match count: " +
          enabledGenerate.count,
      );
    }

    await adapter.clearPrompt();
    console.log("[FlowForge] Test prompt cleared and verified.");

    const finalGenerate = await adapter.discoverGenerate();

    console.log("[FlowForge] Final Generate discovery (prompt cleared):");
    console.log(JSON.stringify(finalGenerate, null, 2));

    if (finalGenerate.matched) {
      throw new Error(
        "Generate control unexpectedly remained enabled after clearing the prompt.",
      );
    }

    console.log("[FlowForge] Generate control state transitions verified.");
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
