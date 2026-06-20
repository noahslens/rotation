import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

const resolveUserId = async (
  ctx: MutationCtx,
  args: {
    userId?: Id<"users">;
    platform?: string;
    platformUserId?: string;
    stripeCustomerId?: string;
  },
) => {
  let userId = args.userId;
  if (!userId && args.platform && args.platformUserId) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_platform_user", (q) =>
        q.eq("platform", args.platform!).eq("platformUserId", args.platformUserId!),
      )
      .unique();
    userId = user?._id;
  }

  if (!userId && args.stripeCustomerId) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_stripe_customer", (q) =>
        q.eq("stripeCustomerId", args.stripeCustomerId!),
      )
      .unique();
    userId = user?._id;
  }

  return userId;
};

export const setSubscriptionStatus = mutation({
  args: {
    userId: v.optional(v.id("users")),
    platform: v.optional(v.string()),
    platformUserId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    subscriptionStatus: v.union(
      v.literal("unknown"),
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("unpaid"),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);

    if (!userId) return null;

    await ctx.db.patch(userId, {
      subscriptionStatus: args.subscriptionStatus,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      updatedAt: args.now,
    });

    return await ctx.db.get(userId);
  },
});

export const queueSubscriptionWelcome = mutation({
  args: {
    userId: v.optional(v.id("users")),
    stripeCustomerId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (!userId) return null;

    const existing = await ctx.db
      .query("outboundNotifications")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "subscription_welcome"),
      )
      .filter((q) => q.neq(q.field("status"), "failed"))
      .first();
    if (existing) return existing._id;

    const requests = await ctx.db
      .query("recommendationRequests")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    const request = requests.find(
      (item) =>
        item.deliveryMode === "after_payment" &&
        item.status === "completed" &&
        item.playlistUrl &&
        !item.deliveredAt,
    );

    return await ctx.db.insert("outboundNotifications", {
      userId,
      kind: "subscription_welcome",
      status: "pending",
      requestId: request?._id,
      createdAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const listPendingNotifications = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const notifications = await ctx.db
      .query("outboundNotifications")
      .withIndex("by_status_created", (q) => q.eq("status", "pending"))
      .order("asc")
      .take(args.limit);

    return await Promise.all(
      notifications.map(async (notification) => ({
        notification,
        user: await ctx.db.get(notification.userId),
        request: notification.requestId
          ? await ctx.db.get(notification.requestId)
          : null,
      })),
    );
  },
});

export const markNotificationSent = mutation({
  args: {
    notificationId: v.id("outboundNotifications"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.notificationId, {
      status: "sent",
      updatedAt: args.now,
    });
  },
});

export const markNotificationFailed = mutation({
  args: {
    notificationId: v.id("outboundNotifications"),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.notificationId, {
      status: "failed",
      error: args.error,
      updatedAt: args.now,
    });
  },
});

export const logStripeEvent = mutation({
  args: {
    stripeEventId: v.string(),
    type: v.string(),
    userId: v.optional(v.id("users")),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billingEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();

    if (existing) return existing._id;

    return await ctx.db.insert("billingEvents", {
      stripeEventId: args.stripeEventId,
      type: args.type,
      userId: args.userId,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      createdAt: args.now,
    });
  },
});
