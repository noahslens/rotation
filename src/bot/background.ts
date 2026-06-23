import { imessage } from "@spectrum-ts/imessage";
import type { Doc } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";
import type { RotationApp, RotationBot } from "./rotationBot";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const initialRetryCooldownMs = 60 * 60 * 1000;
export const shouldProcessInitialPlaylist = (
  item: Pick<
    Doc<"users">,
    "onboardingStage" | "initialPlaylistDeliveredAt" | "initialPlaylistStartedAt"
  >,
  now: number,
) =>
  item.onboardingStage === "linked" &&
  !item.initialPlaylistDeliveredAt &&
  (!item.initialPlaylistStartedAt ||
    now - item.initialPlaylistStartedAt >= initialRetryCooldownMs);
const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string) =>
  await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

const dmForUser = async (app: RotationApp, user: Doc<"users">) => {
  if (user.platform !== "iMessage") return null;
  const im = (imessage as unknown as (app: RotationApp) => {
    user: (id: string) => Promise<unknown>;
    space: { create: (user: unknown) => Promise<unknown> };
  })(app);
  const recipient = await im.user(user.platformUserId);
  return (await im.space.create(recipient)) as Parameters<
    RotationBot["deliverInitialPlaylist"]
  >[0];
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
        const now = Date.now();
        const users = await convex.query(api.users.listLinkedUsers, { limit: 50 });
        const pending = users.filter((item) =>
          shouldProcessInitialPlaylist(item, now),
        );
        if (pending.length) {
          console.info("[background:initial] pending users", {
            count: pending.length,
            userIds: pending.map((user) => user._id),
          });
        }
        for (const user of pending) {
          console.info("[background:initial] creating dm", {
            userId: user._id,
            platformUserId: user.platformUserId,
          });
          const space = await withTimeout(dmForUser(app, user), 15_000, "dmForUser");
          console.info("[background:initial] delivering", {
            userId: user._id,
            hasSpace: Boolean(space),
          });
          if (space) await bot.deliverInitialPlaylist(space, user);
        }
      });
      await sleep(5_000);
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

  const notificationLoop = async () => {
    while (running) {
      await run("notifications", async () => {
        const items = await convex.query(api.billing.listPendingNotifications, {
          limit: 10,
        });
        for (const item of items) {
          const { notification, user, request } = item;
          const claimed = await convex.mutation(api.billing.claimNotification, {
            notificationId: notification._id,
            now: Date.now(),
          });
          if (!claimed) continue;

          if (!user) {
            await convex.mutation(api.billing.markNotificationFailed, {
              notificationId: notification._id,
              error: "user not found",
              now: Date.now(),
            });
            continue;
          }

          try {
            const space = await withTimeout(dmForUser(app, user), 15_000, "dmForUser");
            if (!space) throw new Error("could not create dm");
            await bot.deliverBillingNotification(space, user, request);
            await convex.mutation(api.billing.markNotificationSent, {
              notificationId: notification._id,
              now: Date.now(),
            });
          } catch (caught) {
            await convex.mutation(api.billing.markNotificationFailed, {
              notificationId: notification._id,
              error: caught instanceof Error ? caught.message : String(caught),
              now: Date.now(),
            });
          }
        }
      });
      await sleep(3_000);
    }
  };

  void initialLoop();
  void weeklyLoop();
  void listeningLoop();
  void notificationLoop();

  return () => {
    running = false;
  };
};
