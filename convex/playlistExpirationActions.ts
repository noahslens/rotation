import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";
const refreshSkewMs = 90_000;

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

const base64UrlDecode = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const utf8 = new TextEncoder();
const textDecoder = new TextDecoder();

const encryptionKey = async () => {
  const secret = requiredEnv("SPOTIFY_TOKEN_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
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

const decrypt = async (ciphertext: string) => {
  const [version, encodedIv, encodedCiphertext] = ciphertext.split(":");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) {
    throw new Error("unsupported token ciphertext");
  }
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encodedIv) },
    key,
    base64UrlDecode(encodedCiphertext),
  );
  return textDecoder.decode(plaintext);
};

const wait = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const retryAfterMs = (value: string | null) => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const spotifyTokenRequest = async (
  refreshToken: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in: number;
}> => {
  const clientId = requiredEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requiredEnv("SPOTIFY_CLIENT_SECRET");

  const response = await fetch(`${spotifyAccountsBaseUrl}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
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

  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(
      `spotify refresh failed: ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: payload.token_type,
    scope: payload.scope,
    expires_in: payload.expires_in,
  };
};

const deleteSpotifyPlaylist = async (playlistId: string, accessToken: string) => {
  const path = `${spotifyApiBaseUrl}/playlists/${playlistId}/followers`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(path, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (response.ok || response.status === 404) return;

    const canRetry =
      attempt < 2 &&
      (response.status === 429 || [500, 502, 503, 504].includes(response.status));
    if (canRetry) {
      await wait(Math.min(retryAfterMs(response.headers.get("retry-after")) ?? 1000, 5000));
      continue;
    }

    throw new Error(`spotify playlist delete failed ${response.status}: ${await response.text()}`);
  }
};

type DueExpiration = {
  expiration: Doc<"playlistExpirations">;
  user: Doc<"users"> | null;
  token: Doc<"spotifyTokens"> | null;
};

export const deleteExpiredPlaylists: ReturnType<typeof internalAction> = internalAction({
  args: {
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; deleted: number; failed: number }> => {
    const now = args.now ?? Date.now();
    const due = (await ctx.runQuery(internal.playlistExpirations.listDue, {
      now,
      limit: args.limit ?? 10,
    })) as DueExpiration[];
    let deleted = 0;
    let failed = 0;

    for (const item of due) {
      const claimed = await ctx.runMutation(
        internal.playlistExpirations.markDeleting,
        {
          expirationId: item.expiration._id,
          now: Date.now(),
        },
      );
      if (!claimed) continue;

      try {
        if (!item.user) throw new Error("user not found");
        if (!item.token) throw new Error("spotify token not found");
        let accessToken: string;
        if (item.token.expiresAt - refreshSkewMs > Date.now()) {
          accessToken = await decrypt(item.token.accessTokenCiphertext);
        } else {
          const refreshToken = await decrypt(item.token.refreshTokenCiphertext);
          const refreshed = await spotifyTokenRequest(refreshToken);
          accessToken = refreshed.access_token;
          await ctx.runMutation(api.spotify.saveTokens, {
            userId: item.user._id,
            accessTokenCiphertext: await encrypt(refreshed.access_token),
            refreshTokenCiphertext: refreshed.refresh_token
              ? await encrypt(refreshed.refresh_token)
              : item.token.refreshTokenCiphertext,
            expiresAt: Date.now() + refreshed.expires_in * 1000,
            scope: refreshed.scope ?? item.token.scope,
            tokenType: refreshed.token_type ?? item.token.tokenType,
            now: Date.now(),
          });
        }

        await deleteSpotifyPlaylist(item.expiration.playlistId, accessToken);
        await ctx.runMutation(internal.playlistExpirations.markDeleted, {
          expirationId: item.expiration._id,
          now: Date.now(),
        });
        deleted += 1;
      } catch (caught) {
        failed += 1;
        await ctx.runMutation(internal.playlistExpirations.markFailed, {
          expirationId: item.expiration._id,
          error: caught instanceof Error ? caught.message : String(caught),
          now: Date.now(),
        });
      }
    }

    return { processed: due.length, deleted, failed };
  },
});
