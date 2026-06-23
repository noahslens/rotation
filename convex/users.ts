import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const weekMs = 7 * 24 * 60 * 60 * 1000;

export const upsertFromMessage = mutation({
  args: {
    platform: v.string(),
    platformUserId: v.string(),
    displayName: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_platform_user", (q) =>
        q.eq("platform", args.platform).eq("platformUserId", args.platformUserId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName ?? existing.displayName,
        lastInteractionAt: args.now,
        updatedAt: args.now,
      });
      return { ...existing, displayName: args.displayName ?? existing.displayName };
    }

    const userId = await ctx.db.insert("users", {
      platform: args.platform,
      platformUserId: args.platformUserId,
      displayName: args.displayName,
      onboardingStage: "new",
      spotifyLinked: false,
      hasSeenPaywall: false,
      completedRequestCount: 0,
      subscriptionStatus: "unknown",
      weeklyDiscoveryDueAt: args.now + weekMs,
      lastInteractionAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });

    return await ctx.db.get(userId);
  },
});

export const getByPlatform = query({
  args: {
    platform: v.string(),
    platformUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_platform_user", (q) =>
        q.eq("platform", args.platform).eq("platformUserId", args.platformUserId),
      )
      .unique();
  },
});

export const getById = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

export const setName = mutation({
  args: {
    userId: v.id("users"),
    preferredName: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      preferredName: args.preferredName,
      onboardingStage: "link_sent",
      updatedAt: args.now,
    });
    return await ctx.db.get(args.userId);
  },
});

export const setOnboardingStage = mutation({
  args: {
    userId: v.id("users"),
    onboardingStage: v.union(
      v.literal("new"),
      v.literal("asked_name"),
      v.literal("link_sent"),
      v.literal("linked"),
      v.literal("ready"),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      onboardingStage: args.onboardingStage,
      updatedAt: args.now,
    });
    return await ctx.db.get(args.userId);
  },
});

export const markInitialPlaylistDelivered = mutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      initialPlaylistDeliveredAt: args.now,
      onboardingStage: "ready",
      updatedAt: args.now,
    });
  },
});

export const markInitialPlaylistStarted = mutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      initialPlaylistStartedAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const restartInitialPlaylistByPlatformUser = mutation({
  args: {
    platform: v.string(),
    platformUserId: v.string(),
    now: v.number(),
    replayOnboarding: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_platform_user", (q) =>
        q.eq("platform", args.platform).eq("platformUserId", args.platformUserId),
      )
      .unique();

    if (!user) {
      return {
        reset: false,
        reason: "user not found",
        deletedRequests: 0,
      };
    }

    const requests = await ctx.db
      .query("recommendationRequests")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(100);
    const replayOnboarding = args.replayOnboarding ?? false;
    const initialRequests = requests.filter(
      (request) =>
        request.intent === "initial" &&
        (replayOnboarding ||
          request.status === "started" ||
          request.status === "polling" ||
          request.status === "failed"),
    );

    for (const request of initialRequests) {
      await ctx.db.delete(request._id);
    }

    await ctx.db.patch(user._id, {
      onboardingStage: replayOnboarding
        ? "new"
        : user.spotifyLinked
          ? "linked"
          : user.onboardingStage,
      initialPlaylistStartedAt: undefined,
      initialPlaylistDeliveredAt: undefined,
      ...(replayOnboarding
        ? {
            hasSeenPaywall: false,
            completedRequestCount: 0,
          }
        : {}),
      updatedAt: args.now,
    });

    return {
      reset: true,
      userId: user._id,
      spotifyLinked: user.spotifyLinked,
      lastSpotifySyncAt: user.lastSpotifySyncAt,
      deletedRequests: initialRequests.length,
      replayOnboarding,
    };
  },
});

export const markPaywallShown = mutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      hasSeenPaywall: true,
      updatedAt: args.now,
    });
  },
});

export const incrementCompletedRequests = mutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return;
    await ctx.db.patch(args.userId, {
      completedRequestCount: user.completedRequestCount + 1,
      updatedAt: args.now,
    });
  },
});

export const updateTasteSummary = mutation({
  args: {
    userId: v.id("users"),
    tasteSummary: v.string(),
    activityPreferencesJson: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      tasteSummary: args.tasteSummary,
      activityPreferencesJson: args.activityPreferencesJson,
      updatedAt: args.now,
    });
  },
});

export const listWeeklyDue = query({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_weekly_due", (q) => q.lte("weeklyDiscoveryDueAt", args.now))
      .filter((q) => q.eq(q.field("spotifyLinked"), true))
      .take(args.limit);
  },
});

export const setWeeklyDiscoveryDueAt = mutation({
  args: { userId: v.id("users"), dueAt: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      weeklyDiscoveryDueAt: args.dueAt,
      updatedAt: args.now,
    });
  },
});

export const listLinkedUsers = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_spotify_linked", (q) => q.eq("spotifyLinked", true))
      .take(args.limit);
  },
});

export const recordPlaybackCheck = mutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      lastPlaybackCheckAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const resetByPlatformUser = mutation({
  args: {
    platform: v.string(),
    platformUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_platform_user", (q) =>
        q.eq("platform", args.platform).eq("platformUserId", args.platformUserId),
      )
      .unique();

    if (!user) {
      return {
        reset: false,
        deleted: {},
      };
    }

    const userId = user._id;
    const deleted: Record<string, number> = {};
    const batchSize = 500;
    let deletedThisRun = 0;
    let mayHaveMore = false;

    const remaining = () => Math.max(0, batchSize - deletedThisRun);
    const bump = (table: string) => {
      deleted[table] = (deleted[table] ?? 0) + 1;
      deletedThisRun += 1;
    };
    const deleteDocs = async (
      table: string,
      docs: Array<{ _id: any; storageId?: any }>,
      beforeDelete?: (doc: { _id: any; storageId?: any }) => Promise<void>,
    ) => {
      if (docs.length === remaining()) mayHaveMore = true;
      for (const doc of docs) {
        if (beforeDelete) await beforeDelete(doc);
        await ctx.db.delete(doc._id);
        bump(table);
      }
    };

    if (remaining()) {
      await deleteDocs(
        "spotifyAuthStates",
        await ctx.db
          .query("spotifyAuthStates")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "spotifyTokens",
        await ctx.db
          .query("spotifyTokens")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "spotifyPlaylists",
        await ctx.db
          .query("spotifyPlaylists")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "spotifyTracks",
        await ctx.db
          .query("spotifyTracks")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "userPhotos",
        await ctx.db
          .query("userPhotos")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
        async (doc) => {
          await ctx.storage.delete(doc.storageId);
        },
      );
    }

    if (remaining()) {
      await deleteDocs(
        "conversationTurns",
        await ctx.db
          .query("conversationTurns")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    for (const status of ["open", "answered", "expired"] as const) {
      if (!remaining()) break;
      await deleteDocs(
        "pendingPolls",
        await ctx.db
          .query("pendingPolls")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", status),
          )
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "recommendationRequests",
        await ctx.db
          .query("recommendationRequests")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "playlistExpirations",
        await ctx.db
          .query("playlistExpirations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "listeningSessions",
        await ctx.db
          .query("listeningSessions")
          .withIndex("by_user_context", (q) => q.eq("userId", userId))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "billingEvents",
        await ctx.db
          .query("billingEvents")
          .filter((q) => q.eq(q.field("userId"), userId))
          .take(remaining()),
      );
    }

    for (const kind of ["subscription_welcome"] as const) {
      if (!remaining()) break;
      await deleteDocs(
        "outboundNotifications",
        await ctx.db
          .query("outboundNotifications")
          .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
          .take(remaining()),
      );
    }

    if (remaining()) {
      await deleteDocs(
        "jobFailures",
        await ctx.db
          .query("jobFailures")
          .filter((q) => q.eq(q.field("userId"), userId))
          .take(remaining()),
      );
    }

    if (mayHaveMore || deletedThisRun >= batchSize) {
      return {
        reset: true,
        completed: false,
        userId,
        deleted,
      };
    }

    await ctx.db.delete(userId);
    bump("users");

    return {
      reset: true,
      completed: true,
      userId,
      deleted,
    };
  },
});
