import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const savePhoto = mutation({
  args: {
    userId: v.id("users"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.optional(v.number()),
    sourceMessageId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("userPhotos", {
      userId: args.userId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      sourceMessageId: args.sourceMessageId,
      createdAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const listForUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const photos = await ctx.db
      .query("userPhotos")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .collect();

    return await Promise.all(
      photos.map(async (photo) => ({
        ...photo,
        url: await ctx.storage.getUrl(photo.storageId),
      })),
    );
  },
});

export const markUsed = mutation({
  args: {
    photoId: v.id("userPhotos"),
    playlistId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.photoId, {
      lastUsedForPlaylistId: args.playlistId,
      lastUsedAt: args.now,
      updatedAt: args.now,
    });
  },
});
