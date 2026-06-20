import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { requireEnv } from "./config/env";
import { startBackgroundJobs } from "./bot/background";
import { createRotationBot } from "./bot/rotationBot";

const app = await Spectrum({
  projectId: requireEnv("projectId"),
  projectSecret: requireEnv("projectSecret"),
  providers: [imessage.config()],
  options: { logLevel: "info" },
});

const bot = createRotationBot();
const stopBackgroundJobs = startBackgroundJobs(app, bot);

const shutdown = async () => {
  stopBackgroundJobs();
  await app.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

for await (const [space, message] of app.messages) {
  await bot.handle(space, message);
}
