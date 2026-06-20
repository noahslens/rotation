import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const trackArg = v.object({
  spotifyTrackId: v.string(),
  name: v.string(),
  artists: v.array(v.string()),
  album: v.optional(v.string()),
  uri: v.string(),
  externalUrl: v.optional(v.string()),
  popularity: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  explicit: v.optional(v.boolean()),
  previewUrl: v.optional(v.string()),
  source: v.union(
    v.literal("saved"),
    v.literal("playlist"),
    v.literal("top"),
    v.literal("recommendation"),
    v.literal("created"),
  ),
  playlistIds: v.optional(v.array(v.string())),
});

const playlistArg = v.object({
  spotifyPlaylistId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  ownerName: v.optional(v.string()),
  trackCount: v.number(),
  snapshotId: v.optional(v.string()),
  public: v.optional(v.boolean()),
  externalUrl: v.optional(v.string()),
});

export const createAuthState = mutation({
  args: {
    userId: v.id("users"),
    state: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("spotifyAuthStates", {
      userId: args.userId,
      state: args.state,
      expiresAt: args.expiresAt,
      createdAt: args.now,
    });
    await ctx.db.patch(args.userId, {
      onboardingStage: "link_sent",
      updatedAt: args.now,
    });
    return args.state;
  },
});

export const consumeAuthState = mutation({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("spotifyAuthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();

    if (!record || record.consumedAt || record.expiresAt < args.now) {
      throw new Error("invalid or expired spotify auth state");
    }

    await ctx.db.patch(record._id, { consumedAt: args.now });
    return record;
  },
});

export const saveTokens = mutation({
  args: {
    userId: v.id("users"),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    expiresAt: v.number(),
    scope: v.string(),
    tokenType: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("spotifyTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    const value = {
      userId: args.userId,
      accessTokenCiphertext: args.accessTokenCiphertext,
      refreshTokenCiphertext: args.refreshTokenCiphertext,
      expiresAt: args.expiresAt,
      scope: args.scope,
      tokenType: args.tokenType,
      updatedAt: args.now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("spotifyTokens", value);
    }
  },
});

export const getTokens = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spotifyTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const saveProfile = mutation({
  args: {
    userId: v.id("users"),
    spotifyUserId: v.string(),
    spotifyDisplayName: v.optional(v.string()),
    spotifyEmail: v.optional(v.string()),
    defaultMarket: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      spotifyLinked: true,
      spotifyUserId: args.spotifyUserId,
      spotifyDisplayName: args.spotifyDisplayName,
      spotifyEmail: args.spotifyEmail,
      defaultMarket: args.defaultMarket,
      onboardingStage: "linked",
      updatedAt: args.now,
    });
  },
});

export const saveSnapshot = mutation({
  args: {
    userId: v.id("users"),
    playlists: v.array(playlistArg),
    tracks: v.array(trackArg),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    for (const playlist of args.playlists) {
      const existing = await ctx.db
        .query("spotifyPlaylists")
        .withIndex("by_user_playlist", (q) =>
          q
            .eq("userId", args.userId)
            .eq("spotifyPlaylistId", playlist.spotifyPlaylistId),
        )
        .unique();

      const value = {
        userId: args.userId,
        ...playlist,
        updatedAt: args.now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, value);
      } else {
        await ctx.db.insert("spotifyPlaylists", value);
      }
    }

    for (const track of args.tracks) {
      const existing = await ctx.db
        .query("spotifyTracks")
        .withIndex("by_user_track", (q) =>
          q.eq("userId", args.userId).eq("spotifyTrackId", track.spotifyTrackId),
        )
        .unique();

      if (existing) {
        const playlistIds = Array.from(
          new Set([...(existing.playlistIds ?? []), ...(track.playlistIds ?? [])]),
        );
        await ctx.db.patch(existing._id, {
          ...track,
          playlistIds,
          updatedAt: args.now,
        });
      } else {
        await ctx.db.insert("spotifyTracks", {
          userId: args.userId,
          ...track,
          firstSeenAt: args.now,
          updatedAt: args.now,
        });
      }
    }

    await ctx.db.patch(args.userId, {
      lastSpotifySyncAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const getMusicContext = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const playlists = await ctx.db
      .query("spotifyPlaylists")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(80);
    const tracks = await ctx.db
      .query("spotifyTracks")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(700);

    return { user, playlists, tracks };
  },
});

export const getKnownTrackIds = query({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    const tracks = await ctx.db
      .query("spotifyTracks")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(args.limit);
    return tracks.map((track) => track.spotifyTrackId);
  },
});

export const saveCreatedTracks = mutation({
  args: {
    userId: v.id("users"),
    tracks: v.array(trackArg),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    for (const track of args.tracks) {
      const existing = await ctx.db
        .query("spotifyTracks")
        .withIndex("by_user_track", (q) =>
          q.eq("userId", args.userId).eq("spotifyTrackId", track.spotifyTrackId),
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          ...track,
          updatedAt: args.now,
        });
      } else {
        await ctx.db.insert("spotifyTracks", {
          userId: args.userId,
          ...track,
          firstSeenAt: args.now,
          updatedAt: args.now,
        });
      }
    }
  },
});
