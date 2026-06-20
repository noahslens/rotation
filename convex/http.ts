import { httpRouter } from "convex/server";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";

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
  const response = await fetch(`${spotifyAccountsBaseUrl}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(
      `spotify token exchange failed: ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }

  if (!payload.access_token || !payload.token_type || !payload.scope || !payload.expires_in) {
    throw new Error("spotify token response was missing required fields");
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: payload.token_type,
    scope: payload.scope,
    expires_in: payload.expires_in,
  };
};

const spotifyProfile = async (
  accessToken: string,
): Promise<{
  id: string;
  display_name?: string;
  email?: string;
  country?: string;
}> => {
  const response = await fetch(`${spotifyApiBaseUrl}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as {
    id?: string;
    display_name?: string;
    email?: string;
    country?: string;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(`spotify profile fetch failed: ${payload.error?.message ?? response.status}`);
  }
  if (!payload.id) throw new Error("spotify profile response was missing id");
  return {
    id: payload.id,
    display_name: payload.display_name,
    email: payload.email,
    country: payload.country,
  };
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

  try {
    const authState = await ctx.runMutation(api.spotify.consumeAuthState, {
      state,
      now,
    });

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

    return html(
      "<h1>spotify linked</h1><p>you’re good. head back to messages and rotation will make your first playlist.</p>",
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await ctx.runMutation(api.conversation.recordJobFailure, {
      job: "spotify_oauth_callback",
      payloadJson: JSON.stringify({ state }),
      error: message,
      now,
    });
    return html(
      "<h1>link failed</h1><p>text rotation and ask for a fresh spotify link.</p>",
      500,
    );
  }
});

const health = httpAction(async () => {
  return Response.json({ ok: true, app: "rotation" });
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

export default http;
