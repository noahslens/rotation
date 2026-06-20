import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
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

console.info("[rotation.startup]", {
  providers: ["iMessage"],
  convexUrl: process.env.CONVEX_URL,
  convexSiteUrl: process.env.CONVEX_SITE_URL,
});

const shutdown = async () => {
  stopBackgroundJobs();
  await Promise.allSettled([...pendingHandlers]);
  await app.stop();
  workerLock.release();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

for await (const [space, message] of app.messages) {
  const handler = bot.handle(space, message).catch((caught) => {
    console.error("[rotation.unhandled_message_error]", caught);
  });
  pendingHandlers.add(handler);
  handler.finally(() => pendingHandlers.delete(handler));
}
