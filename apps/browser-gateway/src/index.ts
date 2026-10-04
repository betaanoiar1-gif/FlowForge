import { CdpBrowserGateway } from "@flowforge/browser";

const endpoint = process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

async function main(): Promise<void> {
  const gateway = new CdpBrowserGateway({ endpoint });
  await gateway.connect();

  console.log("[FlowForge] CDP connected to:", displayOrigin(endpoint));
  console.log("[FlowForge] Browser state:", await gateway.state());
  const tabs = await gateway.tabs();
  console.log("[FlowForge] Tabs:", tabs.map((tab) => ({
    id: tab.id,
    url: displayUrl(tab.url),
    title: redact(tab.title),
  })));

  const discovery = await gateway.discoverPage();
  console.log("[FlowForge] Current page:");
  console.log(JSON.stringify({
    url: displayUrl(discovery.url),
    title: redact(discovery.title),
    readyState: discovery.readyState,
  }, null, 2));

  console.log("[FlowForge] Visible semantic controls (form contents omitted):");
  console.log(JSON.stringify(discovery.elements.map((element) => ({
    tagName: element.tagName,
    role: element.role,
    accessibleName: element.role === "textbox" ? "[textbox]" : redact(element.accessibleName),
    href: element.href ? displayUrl(element.href) : null,
    contenteditable: element.contenteditable,
    disabled: element.disabled,
    selected: element.selected,
  })), null, 2));

  const interestingQueries = [
    { id: "textboxes", query: { role: "textbox" } },
    { id: "flow_prompt_editor", query: { role: "textbox", contenteditable: true } },
    { id: "settings", query: { role: "button", name: "Settings trigger", exact: true } },
    { id: "ingredients", query: { role: "button", name: "Add ingredients to the order box", exact: true } },
    { id: "generate", query: { role: "button", name: "Construction begins", exact: true } },
  ] as const;

  console.log("[FlowForge] Target resolution diagnostics:");
  for (const target of interestingQueries) {
    const result = await gateway.resolve(target.query);
    console.log(JSON.stringify({
      id: target.id,
      matched: result.matched,
      count: result.count,
      element: result.element ? {
        tagName: result.element.tagName,
        role: result.element.role,
        accessibleName: result.element.role === "textbox" ? "[textbox]" : redact(result.element.accessibleName),
        selected: result.element.selected,
      } : null,
    }, null, 2));
  }

  console.log("[FlowForge] Redacted read-only DOM diagnostics:");
  console.log(JSON.stringify(await gateway.domDiagnostics(), null, 2));
  await gateway.disconnect();
  console.log("[FlowForge] Read-only workspace diagnostics completed.");
}

function displayOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "[unavailable]";
  }
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[unavailable]";
  }
}

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => displayOrigin(url))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted-token]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, "[redacted-token]")
    .replace(/\b(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(password|token|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? redact(error.message) : "Unknown browser discovery error.";
  console.error("[FlowForge] Workspace discovery failed:", message);
  process.exitCode = 1;
});
