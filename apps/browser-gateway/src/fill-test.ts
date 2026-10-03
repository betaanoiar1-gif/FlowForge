import { CdpBrowserGateway } from "@flowforge/browser";

const endpoint =
  process.env.FLOWFORGE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";

const query = {
  role: "textbox",
  contenteditable: true,
} as const;

const testValue = "FLOWFORGE_FILL_TEST";

async function main(): Promise<void> {
  const gateway = new CdpBrowserGateway({ endpoint });

  await gateway.connect();

  try {
    const target = await gateway.resolve(query);

    console.log("[FlowForge] Initial target:");
    console.log(JSON.stringify(target, null, 2));

    if (!target.matched) {
      throw new Error(
        "Google Flow prompt editor was not resolved semantically."
      );
    }

    const filled = await gateway.fill(query, testValue);

    console.log("[FlowForge] Fill result:");
    console.log(JSON.stringify(filled, null, 2));

    if (!filled.verified || filled.afterValue !== testValue) {
      throw new Error(
        `Fill verification failed. verified=${filled.verified}, afterValue=${JSON.stringify(
          filled.afterValue
        )}`
      );
    }

    const cleared = await gateway.fill(query, "");

    console.log("[FlowForge] Clear result:");
    console.log(JSON.stringify(cleared, null, 2));

    if (!cleared.verified || cleared.afterValue !== "") {
      throw new Error(
        `Clear verification failed. verified=${cleared.verified}, afterValue=${JSON.stringify(
          cleared.afterValue
        )}`
      );
    }

    const finalTarget = await gateway.resolve(query);

    console.log("[FlowForge] Final target:");
    console.log(JSON.stringify(finalTarget, null, 2));

    console.log("[FlowForge] Semantic fill test passed.");
  } finally {
    await gateway.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("[FlowForge] Semantic fill test failed:", error);
  process.exitCode = 1;
});
