import { httpRouter } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";
const stripeToleranceSeconds = 5 * 60;

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rotation</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101214; color: #f7f7f2; }
      main { width: min(30rem, calc(100vw - 3rem)); }
      h1 { font-size: 2rem; margin: 0 0 .75rem; letter-spacing: 0; }
      p { color: #c9cbc2; line-height: 1.45; margin: 0; font-size: 1rem; }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const base64UrlEncode = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const utf8 = new TextEncoder();

const encryptionKey = async () => {
  const secret = requiredEnv("SPOTIFY_TOKEN_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
  ]);
};

const encrypt = async (value: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    utf8.encode(value),
  );
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(ciphertext))}`;
};

const bytesToHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const secureEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
};

const verifyStripeSignature = async (payload: string, header: string | null) => {
  if (!header) throw new Error("missing stripe signature");
  const timestamp = header
    .split(",")
    .find((part) => part.startsWith("t="))
    ?.slice(2);
  const signatures = header
    .split(",")
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) {
    throw new Error("invalid stripe signature header");
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > stripeToleranceSeconds) {
    throw new Error("stale stripe signature");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    utf8.encode(requiredEnv("STRIPE_WEBHOOK_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = bytesToHex(
    await crypto.subtle.sign("HMAC", key, utf8.encode(`${timestamp}.${payload}`)),
  );

  if (!signatures.some((signature) => secureEqual(signature, expected))) {
    throw new Error("invalid stripe signature");
  }
};

type SpotifyTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type SpotifyProfilePayload = {
  id?: string;
  display_name?: string;
  email?: string;
  country?: string;
  error?: { message?: string } | string;
  error_description?: string;
};

class SpotifyTokenError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SpotifyTokenError";
    this.status = status;
  }
}

class SpotifyApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
  }
}

const wait = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const parseRetryAfterMs = (value: string | null) => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
};

const parseSpotifyTokenPayload = (text: string) => {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as SpotifyTokenPayload;
  } catch {
    return { error_description: text.trim() };
  }
};

const parseSpotifyProfilePayload = (text: string) => {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as SpotifyProfilePayload;
  } catch {
    return { error_description: text.trim() };
  }
};

const spotifyTokenErrorMessage = (
  payload: SpotifyTokenPayload,
  status: number,
) =>
  payload.error_description ??
  payload.error ??
  (status === 429 ? "too many requests" : String(status));

const spotifyProfileErrorMessage = (
  payload: SpotifyProfilePayload,
  status: number,
) => {
  if (typeof payload.error === "string") return payload.error;
  return (
    payload.error_description ??
    payload.error?.message ??
    (status === 429 ? "too many requests" : String(status))
  );
};

const spotifyTokenRequest = async (
  body: URLSearchParams,
): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
  expires_in: number;
}> => {
  const clientId = requiredEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requiredEnv("SPOTIFY_CLIENT_SECRET");
  const basic = btoa(`${clientId}:${clientSecret}`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${spotifyAccountsBaseUrl}/api/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const payload = parseSpotifyTokenPayload(await response.text());

    if (response.ok) {
      if (
        !payload.access_token ||
        !payload.token_type ||
        !payload.scope ||
        !payload.expires_in
      ) {
        throw new Error("spotify token response was missing required fields");
      }

      return {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        token_type: payload.token_type,
        scope: payload.scope,
        expires_in: payload.expires_in,
      };
    }

    const canRetry =
      attempt < 2 &&
      (response.status === 429 || [500, 502, 503, 504].includes(response.status));
    if (canRetry) {
      const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
      await wait(Math.min(retryAfter ?? 1000 * (attempt + 1), 5000));
      continue;
    }

    throw new SpotifyTokenError(
      `spotify token exchange failed (${response.status}): ${spotifyTokenErrorMessage(payload, response.status)}`,
      response.status,
    );
  }

  throw new Error("spotify token exchange failed");
};

const spotifyProfile = async (
  accessToken: string,
): Promise<{
  id: string;
  display_name?: string;
  email?: string;
  country?: string;
}> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${spotifyApiBaseUrl}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = parseSpotifyProfilePayload(await response.text());

    if (response.ok) {
      if (!payload.id) throw new Error("spotify profile response was missing id");
      return {
        id: payload.id,
        display_name: payload.display_name,
        email: payload.email,
        country: payload.country,
      };
    }

    const canRetry =
      attempt < 2 &&
      (response.status === 429 || [500, 502, 503, 504].includes(response.status));
    if (canRetry) {
      const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
      await wait(Math.min(retryAfter ?? 1000 * (attempt + 1), 5000));
      continue;
    }

    throw new SpotifyApiError(
      `spotify profile fetch failed (${response.status}): ${spotifyProfileErrorMessage(payload, response.status)}`,
      response.status,
    );
  }

  throw new Error("spotify profile fetch failed");
};

const spotifyCallback = httpAction(async (ctx, request) => {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const error = requestUrl.searchParams.get("error");
  const redirectUri =
    process.env.SPOTIFY_REDIRECT_URI ??
    `${requestUrl.origin}/auth/spotify/callback`;
  const now = Date.now();

  if (error) {
    return html(
      `<h1>spotify said no</h1><p>${error}. text rotation if you want to try again.</p>`,
      400,
    );
  }

  if (!code || !state) {
    return html(
      "<h1>missing link info</h1><p>text rotation and ask for a fresh spotify link.</p>",
      400,
    );
  }

  let userIdForFailure: Id<"users"> | undefined;

  try {
    const authState = await ctx.runQuery(api.spotify.getAuthState, {
      state,
      now,
    });
    userIdForFailure = authState.userId;

    const token = await spotifyTokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    );

    if (!token.refresh_token) {
      throw new Error("spotify did not return a refresh token");
    }

    const profile = await spotifyProfile(token.access_token);
    await ctx.runMutation(api.spotify.saveTokens, {
      userId: authState.userId,
      accessTokenCiphertext: await encrypt(token.access_token),
      refreshTokenCiphertext: await encrypt(token.refresh_token),
      expiresAt: now + token.expires_in * 1000,
      scope: token.scope,
      tokenType: token.token_type,
      now,
    });
    await ctx.runMutation(api.spotify.saveProfile, {
      userId: authState.userId,
      spotifyUserId: profile.id,
      spotifyDisplayName: profile.display_name,
      spotifyEmail: profile.email,
      defaultMarket: profile.country,
      now,
    });
    await ctx.runMutation(api.spotify.markAuthStateConsumed, {
      authStateId: authState._id,
      now,
    });

    return html(
      "<h1>spotify linked</h1><p>you’re good. head back to messages and rotation will make your first playlist.</p>",
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await ctx.runMutation(api.conversation.recordJobFailure, {
      job: "spotify_oauth_callback",
      userId: userIdForFailure,
      payloadJson: JSON.stringify({ state }),
      error: message,
      now,
    });
    const isRateLimited =
      (caught instanceof SpotifyTokenError || caught instanceof SpotifyApiError) &&
      caught.status === 429;
    const needsSpotifyAppAccess =
      caught instanceof SpotifyApiError &&
      caught.status === 403 &&
      /developer dashboard|not registered|allowlist|user access/i.test(message);
    return html(
      isRateLimited
        ? "<h1>spotify is busy</h1><p>wait a minute, then text rotation and ask for a fresh spotify link.</p>"
        : needsSpotifyAppAccess
          ? "<h1>spotify app access needed</h1><p>this spotify account is not added to rotation’s spotify app users yet. add it in the spotify developer dashboard, then text rotation for a fresh link.</p>"
        : "<h1>link failed</h1><p>text rotation and ask for a fresh spotify link.</p>",
      isRateLimited ? 429 : needsSpotifyAppAccess ? 403 : 500,
    );
  }
});

const health = httpAction(async () => {
  return Response.json({ ok: true, app: "rotation" });
});

const mapStripeStatus = (status: string | undefined) => {
  switch (status) {
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
      return status;
    default:
      return "unknown";
  }
};

const stripeWebhook = httpAction(async (ctx, request) => {
  const now = Date.now();
  const rawBody = await request.text();

  try {
    await verifyStripeSignature(rawBody, request.headers.get("stripe-signature"));
    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data?: { object?: Record<string, unknown> };
    };
    const object = event.data?.object ?? {};
    const customer =
      typeof object.customer === "string" ? object.customer : undefined;
    const subscription =
      typeof object.subscription === "string"
        ? object.subscription
        : typeof object.id === "string" && event.type.startsWith("customer.subscription.")
          ? object.id
          : undefined;
    const userId =
      typeof object.client_reference_id === "string"
        ? object.client_reference_id
        : undefined;

    await ctx.runMutation(api.billing.logStripeEvent, {
      stripeEventId: event.id,
      type: event.type,
      userId: userId as never,
      stripeCustomerId: customer,
      stripeSubscriptionId: subscription,
      now,
    });

    if (event.type === "checkout.session.completed") {
      await ctx.runMutation(api.billing.setSubscriptionStatus, {
        userId: userId as never,
        stripeCustomerId: customer,
        stripeSubscriptionId: subscription,
        subscriptionStatus: "active",
        now,
      });
      await ctx.runMutation(api.billing.queueSubscriptionWelcome, {
        userId: userId as never,
        stripeCustomerId: customer,
        now,
      });
    }

    if (event.type.startsWith("customer.subscription.")) {
      await ctx.runMutation(api.billing.setSubscriptionStatus, {
        stripeCustomerId: customer,
        stripeSubscriptionId: subscription,
        subscriptionStatus: mapStripeStatus(
          typeof object.status === "string" ? object.status : undefined,
        ),
        now,
      });
    }

    return Response.json({ received: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await ctx.runMutation(api.conversation.recordJobFailure, {
      job: "stripe_webhook",
      payloadJson: rawBody.slice(0, 4000),
      error: message,
      now,
    });
    return Response.json({ error: message }, { status: 400 });
  }
});

const http = httpRouter();

http.route({
  path: "/auth/spotify/callback",
  method: "GET",
  handler: spotifyCallback,
});

http.route({
  path: "/health",
  method: "GET",
  handler: health,
});

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: stripeWebhook,
});

export default http;
