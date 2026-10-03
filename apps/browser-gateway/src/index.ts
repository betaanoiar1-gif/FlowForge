import { CdpBrowserGateway } from "@flowforge/browser";

const endpoint = process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

async function main(): Promise<void> {
  const gateway = new CdpBrowserGateway({ endpoint });

  await gateway.connect();

  console.log("[FlowForge] CDP connected:", endpoint);
  console.log("[FlowForge] Browser state:", await gateway.state());
  console.log("[FlowForge] Tabs:", await gateway.tabs());

  const discovery = await gateway.discoverPage();

  console.log("[FlowForge] Page discovery:");
  console.log(JSON.stringify(discovery, null, 2));

  await gateway.disconnect();

  console.log("[FlowForge] CDP discovery test completed.");
}

main().catch((error: unknown) => {
  console.error("[FlowForge] CDP discovery test failed:", error);
  process.exitCode = 1;
});
