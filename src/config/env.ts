import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });

if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

export const env = {
  projectId: process.env.PROJECT_ID ?? "",
  projectSecret: process.env.PROJECT_SECRET ?? "",
  convexUrl: process.env.CONVEX_URL ?? "",
  convexSiteUrl: process.env.CONVEX_SITE_URL ?? "",
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  geminiCoverModel: process.env.GEMINI_COVER_MODEL ?? "gemini-3.5-flash",
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
  spotifyTokenEncryptionKey: process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY ?? "",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripePaymentLink: process.env.STRIPE_PAYMENT_LINK ?? "",
  rotationPhone: process.env.ROTATION_PHONE ?? "+16282649071",
};

export const requireEnv = (name: keyof typeof env) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const hasRequiredRuntimeEnv = () =>
  Boolean(
    env.projectId &&
      env.projectSecret &&
      env.convexUrl &&
      env.convexSiteUrl &&
      env.googleApiKey &&
      env.spotifyClientId &&
      env.spotifyClientSecret &&
      env.spotifyTokenEncryptionKey,
  );
