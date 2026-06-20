import { imessage } from "@spectrum-ts/imessage";
import type { Doc } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";
import type { RotationApp, RotationBot } from "./rotationBot";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dmForUser = async (app: RotationApp, user: Doc<"users">) => {
  if (user.platform !== "iMessage") return null;
  const im = (imessage as unknown as (app: RotationApp) => {
    user: (id: string) => Promise<unknown>;
    space: (user: unknown) => Promise<unknown>;
  })(app);
  const recipient = await im.user(user.platformUserId);
  return (await im.space(recipient)) as Parameters<RotationBot["deliverInitialPlaylist"]>[0];
};

export const startBackgroundJobs = (app: RotationApp, bot: RotationBot) => {
  let running = true;

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (caught) {
      console.error(`[background:${name}]`, caught);
    }
  };

  const initialLoop = async () => {
    while (running) {
      await run("initial", async () => {
        const users = await convex.query(api.users.listLinkedUsers, { limit: 50 });
        for (const user of users.filter((item) => !item.initialPlaylistDeliveredAt)) {
          const space = await dmForUser(app, user);
          if (space) await bot.deliverInitialPlaylist(space, user);
        }
      });
      await sleep(20_000);
    }
  };

  const weeklyLoop = async () => {
    while (running) {
      await run("weekly", async () => {
        const users = await convex.query(api.users.listWeeklyDue, {
          now: Date.now(),
          limit: 10,
        });
        for (const user of users) {
          const space = await dmForUser(app, user);
          if (space) await bot.deliverWeeklyDiscovery(space, user);
        }
      });
      await sleep(15 * 60_000);
    }
  };

  const listeningLoop = async () => {
    while (running) {
      await run("listening", async () => {
        const users = await convex.query(api.users.listLinkedUsers, { limit: 50 });
        for (const user of users) {
          const space = await dmForUser(app, user);
          if (space) await bot.maybeAskListeningContext(space, user);
          await convex.mutation(api.users.recordPlaybackCheck, {
            userId: user._id,
            now: Date.now(),
          });
        }
      });
      await sleep(5 * 60_000);
    }
  };

  void initialLoop();
  void weeklyLoop();
  void listeningLoop();

  return () => {
    running = false;
  };
};
