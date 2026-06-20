import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    platform: v.string(),
    platformUserId: v.string(),
    displayName: v.optional(v.string()),
    preferredName: v.optional(v.string()),
    onboardingStage: v.union(
      v.literal("new"),
      v.literal("asked_name"),
      v.literal("link_sent"),
      v.literal("linked"),
      v.literal("ready"),
    ),
    spotifyLinked: v.boolean(),
    spotifyUserId: v.optional(v.string()),
    spotifyDisplayName: v.optional(v.string()),
    spotifyEmail: v.optional(v.string()),
    defaultMarket: v.optional(v.string()),
    tasteSummary: v.optional(v.string()),
    activityPreferencesJson: v.optional(v.string()),
    initialPlaylistStartedAt: v.optional(v.number()),
    initialPlaylistDeliveredAt: v.optional(v.number()),
    hasSeenPaywall: v.boolean(),
    completedRequestCount: v.number(),
    subscriptionStatus: v.union(
      v.literal("unknown"),
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("unpaid"),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    weeklyDiscoveryDueAt: v.optional(v.number()),
    lastInteractionAt: v.number(),
    lastSpotifySyncAt: v.optional(v.number()),
    lastPlaybackCheckAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_platform_user", ["platform", "platformUserId"])
    .index("by_spotify_user", ["spotifyUserId"])
    .index("by_spotify_linked", ["spotifyLinked"])
    .index("by_weekly_due", ["weeklyDiscoveryDueAt"])
    .index("by_stripe_customer", ["stripeCustomerId"]),

  spotifyAuthStates: defineTable({
    state: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_user", ["userId"]),

  spotifyTokens: defineTable({
    userId: v.id("users"),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    expiresAt: v.number(),
    scope: v.string(),
    tokenType: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  spotifyPlaylists: defineTable({
    userId: v.id("users"),
    spotifyPlaylistId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    ownerId: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    trackCount: v.number(),
    snapshotId: v.optional(v.string()),
    public: v.optional(v.boolean()),
    externalUrl: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_playlist", ["userId", "spotifyPlaylistId"]),

  spotifyTracks: defineTable({
    userId: v.id("users"),
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
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_track", ["userId", "spotifyTrackId"])
    .index("by_user_source", ["userId", "source"]),

  conversationTurns: defineTable({
    userId: v.id("users"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.string(),
    messageId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_created", ["userId", "createdAt"]),

  pendingPolls: defineTable({
    userId: v.id("users"),
    originalPrompt: v.string(),
    deliveryMode: v.optional(
      v.union(v.literal("immediate"), v.literal("after_payment")),
    ),
    question: v.string(),
    options: v.array(v.string()),
    status: v.union(
      v.literal("open"),
      v.literal("answered"),
      v.literal("expired"),
    ),
    selectedOption: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_expires", ["expiresAt"]),

  recommendationRequests: defineTable({
    userId: v.id("users"),
    prompt: v.string(),
    intent: v.string(),
    deliveryMode: v.optional(
      v.union(v.literal("immediate"), v.literal("after_payment")),
    ),
    status: v.union(
      v.literal("started"),
      v.literal("polling"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    playlistId: v.optional(v.string()),
    playlistUrl: v.optional(v.string()),
    trackIds: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_created", ["userId", "createdAt"]),

  billingEvents: defineTable({
    stripeEventId: v.string(),
    type: v.string(),
    userId: v.optional(v.id("users")),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_stripe_event", ["stripeEventId"]),

  outboundNotifications: defineTable({
    userId: v.id("users"),
    kind: v.union(v.literal("subscription_welcome")),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    requestId: v.optional(v.id("recommendationRequests")),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_created", ["status", "createdAt"])
    .index("by_user_kind", ["userId", "kind"]),

  listeningSessions: defineTable({
    userId: v.id("users"),
    spotifyContextUri: v.optional(v.string()),
    spotifyContextName: v.optional(v.string()),
    startedAt: v.number(),
    lastSeenAt: v.number(),
    lastTrackId: v.optional(v.string()),
    askedActivityAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_context", ["userId", "spotifyContextUri"]),

  jobFailures: defineTable({
    job: v.string(),
    userId: v.optional(v.id("users")),
    payloadJson: v.optional(v.string()),
    error: v.string(),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
});
