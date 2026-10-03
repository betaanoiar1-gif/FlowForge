import { CdpBrowserGateway } from "@flowforge/browser";

const endpoint = process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

async function main(): Promise<void> {
  const gateway = new CdpBrowserGateway({ endpoint });

  await gateway.connect();

  console.log("[FlowForge] CDP connected:", endpoint);
  console.log("[FlowForge] Browser state:", await gateway.state());
  console.log("[FlowForge] Tabs:", await gateway.tabs());

  const discovery = await gateway.discoverPage();

  console.log("[FlowForge] Current page:");
  console.log(JSON.stringify({
    url: discovery.url,
    title: discovery.title,
    readyState: discovery.readyState,
  }, null, 2));

  console.log("[FlowForge] Semantic elements:");
  console.log(JSON.stringify(discovery.elements, null, 2));

  const interestingQueries = [
    { id: "textboxes", query: { role: "textbox" } },
    { id: "settings", query: { role: "button", name: "Settings trigger", exact: true } },
    { id: "ingredients", query: { role: "button", name: "Add ingredients to the order box", exact: true } },
    { id: "generate", query: { role: "button", name: "Construction begins", exact: true } },
  ] as const;

  console.log("[FlowForge] Target resolution diagnostics:");

  for (const target of interestingQueries) {
    const result = await gateway.resolve(target.query);
    console.log(JSON.stringify({ id: target.id, ...result }, null, 2));
  }

  console.log("[FlowForge] Read-only DOM diagnostics:");

  const diagnostics = await gateway.domDiagnostics();

  console.log(JSON.stringify(diagnostics, null, 2));

  await gateway.disconnect();

  console.log("[FlowForge] Read-only workspace diagnostics completed.");
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Workspace discovery failed:", error);
  process.exitCode = 1;
});
