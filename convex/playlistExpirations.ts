import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

export const scheduleForLatestPlaylist = mutation({
  args: {
    userId: v.id("users"),
    deleteAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const requests = await ctx.db
      .query("recommendationRequests")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(30);
    const request = requests.find(
      (item) =>
        item.status === "completed" &&
        item.playlistId &&
        item.playlistUrl &&
        item.autoDeleteStatus !== "deleted",
    );
    if (!request?.playlistId) return null;

    const cachedPlaylist = await ctx.db
      .query("spotifyPlaylists")
      .withIndex("by_user_playlist", (q) =>
        q
          .eq("userId", args.userId)
          .eq("spotifyPlaylistId", request.playlistId as string),
      )
      .unique();

    const existing = await ctx.db
      .query("playlistExpirations")
      .withIndex("by_user_playlist", (q) =>
        q.eq("userId", args.userId).eq("playlistId", request.playlistId as string),
      )
      .first();

    const value = {
      userId: args.userId,
      requestId: request._id,
      playlistId: request.playlistId,
      playlistUrl: request.playlistUrl,
      playlistName: cachedPlaylist?.name,
      deleteAt: args.deleteAt,
      status: "scheduled" as const,
      error: undefined,
      deletedAt: undefined,
      updatedAt: args.now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("playlistExpirations", {
        ...value,
        createdAt: args.now,
      });
    }

    await ctx.db.patch(request._id, {
      autoDeleteAt: args.deleteAt,
      autoDeleteStatus: "scheduled",
      autoDeleteError: undefined,
      updatedAt: args.now,
    });

    return {
      requestId: request._id,
      playlistId: request.playlistId,
      playlistUrl: request.playlistUrl,
      playlistName: cachedPlaylist?.name,
      deleteAt: args.deleteAt,
    };
  },
});

export const listDue = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const expirations = await ctx.db
      .query("playlistExpirations")
      .withIndex("by_status_delete", (q) =>
        q.eq("status", "scheduled").lte("deleteAt", args.now),
      )
      .take(args.limit);

    return await Promise.all(
      expirations.map(async (expiration) => ({
        expiration,
        user: await ctx.db.get(expiration.userId),
        token: await ctx.db
          .query("spotifyTokens")
          .withIndex("by_user", (q) => q.eq("userId", expiration.userId))
          .unique(),
      })),
    );
  },
});

export const markDeleting = internalMutation({
  args: { expirationId: v.id("playlistExpirations"), now: v.number() },
  handler: async (ctx, args) => {
    const expiration = await ctx.db.get(args.expirationId);
    if (!expiration || expiration.status !== "scheduled") return false;
    await ctx.db.patch(args.expirationId, {
      status: "deleting",
      updatedAt: args.now,
    });
    if (expiration.requestId) {
      await ctx.db.patch(expiration.requestId, {
        autoDeleteStatus: "deleting",
        updatedAt: args.now,
      });
    }
    return true;
  },
});

export const markDeleted = internalMutation({
  args: { expirationId: v.id("playlistExpirations"), now: v.number() },
  handler: async (ctx, args) => {
    const expiration = await ctx.db.get(args.expirationId);
    if (!expiration) return;
    await ctx.db.patch(args.expirationId, {
      status: "deleted",
      deletedAt: args.now,
      error: undefined,
      updatedAt: args.now,
    });
    if (expiration.requestId) {
      await ctx.db.patch(expiration.requestId, {
        autoDeleteStatus: "deleted",
        autoDeletedAt: args.now,
        autoDeleteError: undefined,
        updatedAt: args.now,
      });
    }

    const cachedPlaylist = await ctx.db
      .query("spotifyPlaylists")
      .withIndex("by_user_playlist", (q) =>
        q.eq("userId", expiration.userId).eq("spotifyPlaylistId", expiration.playlistId),
      )
      .unique();
    if (cachedPlaylist) await ctx.db.delete(cachedPlaylist._id);
  },
});

export const markFailed = internalMutation({
  args: {
    expirationId: v.id("playlistExpirations"),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const expiration = await ctx.db.get(args.expirationId);
    if (!expiration) return;
    await ctx.db.patch(args.expirationId, {
      status: "failed",
      error: args.error,
      updatedAt: args.now,
    });
    if (expiration.requestId) {
      await ctx.db.patch(expiration.requestId, {
        autoDeleteStatus: "failed",
        autoDeleteError: args.error,
        updatedAt: args.now,
      });
    }
  },
});
