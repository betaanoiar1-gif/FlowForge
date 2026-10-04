import { CdpBrowserGateway } from "@flowforge/browser";

/** Script-authored failure text; safe to print because it never contains page content. */
class DiagnosticError extends Error {}

const endpoint = process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const query = { role: "textbox", contenteditable: true } as const;
const testValue = "FLOWFORGE_FILL_TEST";

async function main(): Promise<void> {
  const gateway = new CdpBrowserGateway({ endpoint });
  await gateway.connect();

  try {
    const target = await gateway.resolve(query);
    console.log("[FlowForge] Prompt editor resolved:", target.matched, "count:", target.count);
    if (!target.matched || !target.element) throw new DiagnosticError("Prompt editor was not uniquely resolved.");

    const filled = await gateway.fill(query, testValue, 5_000, { expectedBeforeValue: "" });
    console.log("[FlowForge] Fill result:", {
      matched: filled.matched,
      verified: filled.verified,
      beforeLength: filled.beforeLength,
      afterLength: filled.afterLength,
    });
    if (!filled.verified || filled.afterLength !== testValue.length) throw new DiagnosticError("Fill read-back verification failed.");

    const cleared = await gateway.fill(query, "", 5_000, { expectedBeforeValue: testValue });
    console.log("[FlowForge] Clear result:", {
      matched: cleared.matched,
      verified: cleared.verified,
      afterLength: cleared.afterLength,
    });
    if (!cleared.verified || cleared.afterLength !== 0) throw new DiagnosticError("Clear read-back verification failed.");

    const finalTarget = await gateway.resolve(query);
    console.log("[FlowForge] Prompt editor after clear:", {
      matched: finalTarget.matched,
      count: finalTarget.count,
      remainingLength: finalTarget.element?.text.length ?? 0,
    });
    console.log("[FlowForge] Semantic fill test passed; no Generate action was dispatched.");
  } finally {
    await gateway.disconnect();
  }
}

main().catch((error: unknown) => {
  // Raw browser errors can echo editable page contents, so only script-authored text is printed.
  console.error(
    error instanceof DiagnosticError
      ? `[FlowForge] Semantic fill test failed: ${error.message}`
      : "[FlowForge] Semantic fill test failed. Browser detail was omitted to protect page contents.",
  );
  process.exitCode = 1;
});
