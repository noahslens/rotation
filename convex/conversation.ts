import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const logTurn = mutation({
  args: {
    userId: v.id("users"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.string(),
    messageId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("conversationTurns", {
      userId: args.userId,
      direction: args.direction,
      text: args.text,
      messageId: args.messageId,
      createdAt: args.now,
    });
  },
});

export const recentTurns = query({
  args: {
    userId: v.id("users"),
    limit: v.number(),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("conversationTurns")
      .withIndex("by_user_created", (q) => {
        const byUser = q.eq("userId", args.userId);
        return args.since === undefined
          ? byUser
          : byUser.gte("createdAt", args.since);
      })
      .order("desc")
      .take(args.limit);
    return turns.reverse();
  },
});

export const createRequest = mutation({
  args: {
    userId: v.id("users"),
    prompt: v.string(),
    intent: v.string(),
    deliveryMode: v.optional(
      v.union(v.literal("immediate"), v.literal("after_payment")),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("recommendationRequests", {
      userId: args.userId,
      prompt: args.prompt,
      intent: args.intent,
      deliveryMode: args.deliveryMode ?? "immediate",
      status: "started",
      createdAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const finishRequest = mutation({
  args: {
    requestId: v.id("recommendationRequests"),
    playlistId: v.optional(v.string()),
    playlistUrl: v.optional(v.string()),
    trackIds: v.optional(v.array(v.string())),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "completed",
      playlistId: args.playlistId,
      playlistUrl: args.playlistUrl,
      trackIds: args.trackIds,
      updatedAt: args.now,
    });
  },
});

export const markRequestDelivered = mutation({
  args: {
    requestId: v.id("recommendationRequests"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      deliveredAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const latestUndeliveredPaidRequest = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const requests = await ctx.db
      .query("recommendationRequests")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(20);

    return (
      requests.find(
        (request) =>
          request.deliveryMode === "after_payment" &&
          request.status === "completed" &&
          request.playlistUrl &&
          !request.deliveredAt,
      ) ?? null
    );
  },
});

export const failRequest = mutation({
  args: {
    requestId: v.id("recommendationRequests"),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "failed",
      error: args.error,
      updatedAt: args.now,
    });
  },
});

export const createPendingPoll = mutation({
  args: {
    userId: v.id("users"),
    originalPrompt: v.string(),
    deliveryMode: v.optional(
      v.union(v.literal("immediate"), v.literal("after_payment")),
    ),
    question: v.string(),
    options: v.array(v.string()),
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("pendingPolls", {
      userId: args.userId,
      originalPrompt: args.originalPrompt,
      deliveryMode: args.deliveryMode ?? "immediate",
      question: args.question,
      options: args.options,
      status: "open",
      expiresAt: args.expiresAt,
      createdAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const getOpenPoll = query({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    const poll = await ctx.db
      .query("pendingPolls")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "open"),
      )
      .order("desc")
      .first();

    if (!poll) return null;
    if (poll.expiresAt < args.now) return null;
    return poll;
  },
});

export const resolvePendingPoll = mutation({
  args: {
    pollId: v.id("pendingPolls"),
    selectedOption: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pollId, {
      status: "answered",
      selectedOption: args.selectedOption,
      updatedAt: args.now,
    });
  },
});

export const recordJobFailure = mutation({
  args: {
    job: v.string(),
    userId: v.optional(v.id("users")),
    payloadJson: v.optional(v.string()),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("jobFailures", {
      job: args.job,
      userId: args.userId,
      payloadJson: args.payloadJson,
      error: args.error,
      createdAt: args.now,
    });
  },
});

export const recentJobFailures = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobFailures")
      .withIndex("by_created")
      .order("desc")
      .take(args.limit);
  },
});
