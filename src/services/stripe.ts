import Stripe from "stripe";
import { env } from "../config/env";
import type { Doc } from "../../convex/_generated/dataModel";

const stripeClient = () =>
  env.stripeSecretKey
    ? new Stripe(env.stripeSecretKey, { typescript: true })
    : null;

export const paymentLinkForUser = (userId: string) => {
  if (!env.stripePaymentLink) return "";
  const url = new URL(env.stripePaymentLink);
  url.searchParams.set("client_reference_id", userId);
  return url.toString();
};

export const paywallText = (
  userId: string,
  options: { buildingPlaylist?: boolean } = {},
) => {
  const link = paymentLinkForUser(userId);
  const devCardNote =
    "dev note: enter 4242 4242 4242 4242 as your card number, and any exp + cvv.";
  if (!link) {
    return "rotation is $29.99/y, but the stripe link isn't configured yet.";
  }
  if (options.buildingPlaylist) {
    return `rotation is $29.99/y. lock it in and i'll make that playlist next.\n\n${devCardNote}`;
  }
  return `rotation is $29.99/y. lock it in and i'll keep making playlists over text.\n\n${devCardNote}`;
};

export const billingPortalText = async (user: Doc<"users">) => {
  if (!user.stripeCustomerId) {
    if (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing") {
      return "i don't have your stripe customer attached yet. send me “billing” after your payment receipt lands and i'll pull up the portal.";
    }
    return "i don't see an active subscription for you yet. if you're trying to start one, use this: " + paymentLinkForUser(user._id);
  }

  const stripe = stripeClient();
  if (!stripe) {
    return "i found your subscription, but billing portal isn't configured on my side yet.";
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: env.convexSiteUrl ? `${env.convexSiteUrl}/health` : undefined,
  });

  return `manage, update, or cancel your rotation subscription here: ${session.url}`;
};
