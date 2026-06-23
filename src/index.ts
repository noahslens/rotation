import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { requireEnv } from "./config/env";
import { startBackgroundJobs } from "./bot/background";
import { createRotationBot } from "./bot/rotationBot";
import { acquireProcessLock } from "./utils/processLock";

const workerLock = acquireProcessLock("rotation-worker");

const app = await Spectrum({
  projectId: requireEnv("projectId"),
  projectSecret: requireEnv("projectSecret"),
  providers: [imessage.config()],
  options: { logLevel: "info" },
});

const imessageProvider = imessage(app);
const bot = createRotationBot({
  attachmentFetcher: {
    getAttachment: (id, phone) => imessageProvider.getAttachment(id, phone),
  },
});
const stopBackgroundJobs = startBackgroundJobs(app, bot);
const pendingHandlers = new Set<Promise<void>>();
const seenMessageIds = new Set<string>();
const seenMessageOrder: string[] = [];
const seenMessageLimit = 2_000;

type InternalSpectrumState = {
  client?: unknown;
  projectConfig?: {
    profile?: {
      imessageSynced?: boolean;
    };
  };
};

const describeImessageRuntime = () => {
  const platformState = app.__internal.platforms.get("iMessage") as InternalSpectrumState | undefined;
  const client = platformState?.client;
  const phones = Array.isArray(client)
    ? client
        .map((entry) =>
          typeof entry === "object" && entry !== null && "phone" in entry
            ? String(entry.phone)
            : "unknown",
        )
        .sort()
    : ["local"];

  return {
    phones,
    imessageSynced: platformState?.projectConfig?.profile?.imessageSynced === true,
  };
};

const rememberMessage = (id: string) => {
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  seenMessageOrder.push(id);
  while (seenMessageOrder.length > seenMessageLimit) {
    const next = seenMessageOrder.shift();
    if (next) seenMessageIds.delete(next);
  }
  return true;
};

const normalizeHeaders = (headers: IncomingHttpHeaders) => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key] = value.join(", ");
    else if (value !== undefined) normalized[key] = value;
  }
  return normalized;
};

const readRequestBody = async (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });

const dispatchMessage = (source: "stream" | "webhook", space: Space, message: Message) => {
  console.info(`[rotation.${source}_received_raw]`, {
    id: message.id,
    direction: message.direction,
    contentType: message.content.type,
    senderId: message.sender?.id,
    spaceId: space.id,
    spaceType: (space as { type?: string }).type,
  });

  if (!rememberMessage(message.id)) {
    console.info("[rotation.duplicate_message_skipped]", { source, id: message.id });
    return Promise.resolve();
  }

  const handler = bot.handle(space, message).catch((caught) => {
    console.error("[rotation.unhandled_message_error]", caught);
  });
  pendingHandlers.add(handler);
  handler.finally(() => pendingHandlers.delete(handler));
  return handler;
};

const startWebhookServer = () => {
  const rawPort = process.env.SPECTRUM_WEBHOOK_PORT ?? process.env.PORT;
  if (!rawPort) return () => Promise.resolve();

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    console.warn("[rotation.webhook_disabled]", { reason: "invalid port", port: rawPort });
    return () => Promise.resolve();
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/spectrum/webhook") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }

      const result = await app.webhook(
        {
          body: await readRequestBody(request),
          headers: normalizeHeaders(request.headers),
        },
        async (space, message) => {
          await dispatchMessage("webhook", space, message);
        },
      );
      response.writeHead(result.status, result.headers);
      response.end(Buffer.from(result.body));
    } catch (caught) {
      console.error("[rotation.webhook_error]", caught);
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("webhook error");
    }
  });

  server.listen(port, () => {
    console.info("[rotation.webhook_listening]", {
      port,
      path: "/spectrum/webhook",
      hasSecret: Boolean(process.env.SPECTRUM_WEBHOOK_SECRET),
    });
  });

  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
};

console.info("[rotation.startup]", {
  providers: ["iMessage"],
  convexUrl: process.env.CONVEX_URL,
  convexSiteUrl: process.env.CONVEX_SITE_URL,
  imessage: describeImessageRuntime(),
});

const stopWebhookServer = startWebhookServer();

const shutdown = async () => {
  stopBackgroundJobs();
  await stopWebhookServer();
  await Promise.allSettled([...pendingHandlers]);
  await app.stop();
  workerLock.release();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.info("[rotation.message_loop_start]", { startedAt: new Date().toISOString() });

try {
  for await (const [space, message] of app.messages) {
    dispatchMessage("stream", space, message);
  }

  console.error("[rotation.message_loop_ended]");
} catch (caught) {
  console.error("[rotation.message_loop_failed]", caught);
  process.exitCode = 1;
}
