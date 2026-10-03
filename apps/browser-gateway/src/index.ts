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

  const projectQuery = {
    role: "link",
    name: "Project opening",
    exact: true,
  } as const;

  const resolved = await gateway.resolve(projectQuery);

  console.log("[FlowForge] Project target:");
  console.log(JSON.stringify(resolved, null, 2));

  if (!resolved.matched) {
    throw new Error(
      `Project opening is not uniquely resolvable. Match count: ${resolved.count}`,
    );
  }

  console.log("[FlowForge] Executing semantic click: Project opening");

  const action = await gateway.click(projectQuery);

  console.log("[FlowForge] Click result:");
  console.log(JSON.stringify(action, null, 2));

  if (!action.verified) {
    throw new Error(
      action.error ?? "Semantic click verification failed.",
    );
  }

  console.log("[FlowForge] Semantic click verified.");
  await gateway.disconnect();

  console.log("[FlowForge] Action + verification test completed.");
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Action + verification test failed:", error);
  process.exitCode = 1;
});
