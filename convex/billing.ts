import { mutation } from "./_generated/server";
import { v } from "convex/values";

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
