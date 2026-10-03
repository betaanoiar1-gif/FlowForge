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

  const diagnostics = await discoveryDiagnostics();

  console.log(JSON.stringify(diagnostics, null, 2));

  await gateway.disconnect();

  console.log("[FlowForge] Read-only workspace diagnostics completed.");
}

async function discoveryDiagnostics(): Promise<unknown> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  const result = await page.evaluate(() => {
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);

    const describe = (element: Element) => {
      const html = element.outerHTML.slice(0, 1200);
      const parent = element.parentElement;
      const parentText = clean(parent?.innerText);
      return {
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
        contenteditable: element.getAttribute("contenteditable"),
        value: element instanceof HTMLInputElement ? element.value : null,
        text: clean(element.textContent),
        parentText,
        html,
      };
    };

    return {
      inputs: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).map(describe),
      buttons: Array.from(document.querySelectorAll("button")).map(describe),
    };
  });

  await browser.close();
  return result;
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Workspace discovery failed:", error);
  process.exitCode = 1;
});
