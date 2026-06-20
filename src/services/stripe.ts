import { env } from "../config/env";

export const paymentLinkForUser = (userId: string) => {
  if (!env.stripePaymentLink) return "";
  const url = new URL(env.stripePaymentLink);
  url.searchParams.set("client_reference_id", userId);
  return url.toString();
};

export const paywallText = (userId: string) => {
  const link = paymentLinkForUser(userId);
  if (!link) {
    return "quick thing: rotation is $29.99/y. stripe link isn't configured yet.";
  }
  return `quick thing: rotation is $29.99/y. lock it in here: ${link}`;
};
