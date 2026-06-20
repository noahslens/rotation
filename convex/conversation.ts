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
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversationTurns")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit);
  },
});

export const createRequest = mutation({
  args: {
    userId: v.id("users"),
    prompt: v.string(),
    intent: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("recommendationRequests", {
      userId: args.userId,
      prompt: args.prompt,
      intent: args.intent,
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
    question: v.string(),
    options: v.array(v.string()),
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("pendingPolls", {
      userId: args.userId,
      originalPrompt: args.originalPrompt,
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
