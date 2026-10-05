import type { CDPSession, Page } from "playwright-core";
import type {
  NetworkDiagnosticRecord,
  NetworkDiagnosticsHandle,
  NetworkDiagnosticsOptions,
} from "./index.js";

const FLOW_RPC_HOST = "flow.google.com";

const FLOW_RPC_MARKERS = [
  "/_/AiSandboxAngularFrontend/data/batchexecute",
  "/_/AiSandboxAngularFrontend/data/google.internal.labs.aisandbox.proto.flow.agent.v1.FlowCreationAgentService/",
];

function isInterestingFlowRequest(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === FLOW_RPC_HOST &&
      FLOW_RPC_MARKERS.some((marker) =>
        parsed.pathname.startsWith(marker),
      )
    );
  } catch {
    return false;
  }
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function truncateBody(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) {
    return body;
  }

  return `${Buffer.from(body, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")}\n...[truncated]`;
}

export async function startNetworkDiagnostics(
  page: Page,
  options: NetworkDiagnosticsOptions = {},
): Promise<NetworkDiagnosticsHandle> {
  const session: CDPSession =
    await page.context().newCDPSession(page);

  const captureResponseBody =
    options.captureResponseBody === true;

  const maxBodyBytes =
    options.maxBodyBytes ?? 64 * 1024;

  const records: NetworkDiagnosticRecord[] = [];

  const responseRequests = new Set<string>();

  const onRequest = (event: {
    requestId: string;
    request: {
      url: string;
      method: string;
    };
    type?: string;
    timestamp: number;
  }) => {
    if (!isInterestingFlowRequest(event.request.url)) {
      return;
    }

    responseRequests.add(event.requestId);

    records.push({
      kind: "request",
      requestId: event.requestId,
      url: safeUrl(event.request.url),
      method: event.request.method,
      resourceType: event.type,
      timestamp: event.timestamp,
    });
  };

  const onResponse = (event: {
    requestId: string;
    response: {
      url: string;
      status: number;
    };
    type?: string;
    timestamp: number;
  }) => {
    if (!isInterestingFlowRequest(event.response.url)) {
      return;
    }

    records.push({
      kind: "response",
      requestId: event.requestId,
      url: safeUrl(event.response.url),
      status: event.response.status,
      resourceType: event.type,
      timestamp: event.timestamp,
    });
  };

  session.on(
    "Network.requestWillBeSent",
    onRequest,
  );

  session.on(
    "Network.responseReceived",
    onResponse,
  );

  await session.send("Network.enable");

  let stopped = false;

  return {
    async stop() {
      if (stopped) {
        return [...records];
      }

      stopped = true;

      session.off(
        "Network.requestWillBeSent",
        onRequest,
      );

      session.off(
        "Network.responseReceived",
        onResponse,
      );

      if (captureResponseBody) {
        for (const requestId of responseRequests) {
          try {
            const result = await session.send(
              "Network.getResponseBody",
              { requestId },
            );

            const body =
              typeof result.body === "string"
                ? truncateBody(
                    result.body,
                    maxBodyBytes,
                  )
                : "";

            const record = records.find(
              (item) =>
                item.kind === "response" &&
                item.requestId === requestId,
            );

            if (record && body) {
              record.body = body;
            }
          } catch {
            // Some CDP requests are no longer available
            // when diagnostics are stopped.
          }
        }
      }

      await session.send("Network.disable");
      await session.detach();

      return [...records];
    },
  };
}
