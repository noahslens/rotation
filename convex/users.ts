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

    const bump = (table: string) => {
      deleted[table] = (deleted[table] ?? 0) + 1;
    };

    for (const doc of await ctx.db
      .query("spotifyAuthStates")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("spotifyAuthStates");
    }

    for (const doc of await ctx.db
      .query("spotifyTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("spotifyTokens");
    }

    for (const doc of await ctx.db
      .query("spotifyPlaylists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("spotifyPlaylists");
    }

    for (const doc of await ctx.db
      .query("spotifyTracks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("spotifyTracks");
    }

    for (const doc of await ctx.db
      .query("conversationTurns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("conversationTurns");
    }

    for (const status of ["open", "answered", "expired"] as const) {
      for (const doc of await ctx.db
        .query("pendingPolls")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", userId).eq("status", status),
        )
        .collect()) {
        await ctx.db.delete(doc._id);
        bump("pendingPolls");
      }
    }

    for (const doc of await ctx.db
      .query("recommendationRequests")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("recommendationRequests");
    }

    for (const doc of await ctx.db
      .query("listeningSessions")
      .withIndex("by_user_context", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("listeningSessions");
    }

    for (const doc of await ctx.db
      .query("billingEvents")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("billingEvents");
    }

    for (const doc of await ctx.db
      .query("jobFailures")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect()) {
      await ctx.db.delete(doc._id);
      bump("jobFailures");
    }

    await ctx.db.delete(userId);
    bump("users");

    return {
      reset: true,
      userId,
      deleted,
    };
  },
});
