import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsertSession = mutation({
  args: {
    userId: v.id("users"),
    spotifyContextUri: v.optional(v.string()),
    spotifyContextName: v.optional(v.string()),
    lastTrackId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listeningSessions")
      .withIndex("by_user_context", (q) =>
        q
          .eq("userId", args.userId)
          .eq("spotifyContextUri", args.spotifyContextUri),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        spotifyContextName: args.spotifyContextName ?? existing.spotifyContextName,
        lastSeenAt: args.now,
        lastTrackId: args.lastTrackId,
        updatedAt: args.now,
      });
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("listeningSessions", {
      userId: args.userId,
      spotifyContextUri: args.spotifyContextUri,
      spotifyContextName: args.spotifyContextName,
      startedAt: args.now,
      lastSeenAt: args.now,
      lastTrackId: args.lastTrackId,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return await ctx.db.get(id);
  },
});

export const markAskedActivity = mutation({
  args: { sessionId: v.id("listeningSessions"), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      askedActivityAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const getSession = query({
  args: {
    userId: v.id("users"),
    spotifyContextUri: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("listeningSessions")
      .withIndex("by_user_context", (q) =>
        q
          .eq("userId", args.userId)
          .eq("spotifyContextUri", args.spotifyContextUri),
      )
      .unique();
  },
});
