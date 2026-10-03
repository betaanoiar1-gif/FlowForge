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

  console.log("[FlowForge] Semantic controls discovered:");

  const interesting = discovery.elements.filter((element) => {
    const value = [
      element.role ?? "",
      element.accessibleName,
      element.text,
      element.href ?? "",
      element.inputType ?? "",
    ].join(" ").toLowerCase();

    return /prompt|generate|video|image|upload|reference|ingredient|frame|agent|model|download|scene|character|asset|create|submit/.test(value);
  });

  console.log(JSON.stringify(interesting, null, 2));

  console.log("[FlowForge] Total semantic elements:", discovery.elements.length);
  console.log("[FlowForge] Matching workspace candidates:", interesting.length);

  await gateway.disconnect();

  console.log("[FlowForge] Read-only workspace discovery completed.");
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Workspace discovery failed:", error);
  process.exitCode = 1;
});
