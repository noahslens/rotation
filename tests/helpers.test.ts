import assert from "node:assert/strict";
import test from "node:test";

process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY = "test encryption key";
process.env.STRIPE_PAYMENT_LINK = "https://buy.stripe.com/test_abc123";

test("base64url round trips bytes without padding", async () => {
  const { base64UrlDecode, base64UrlEncode } = await import(
    "../src/utils/base64url"
  );
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);

  assert.equal(encoded.includes("="), false);
  assert.deepEqual(base64UrlDecode(encoded), bytes);
});

test("token encryption round trips without storing plaintext", async () => {
  const { decryptToken, encryptToken } = await import("../src/utils/tokenCrypto");

  const encrypted = await encryptToken("spotify-access-token");

  assert.notEqual(encrypted, "spotify-access-token");
  assert.match(encrypted, /^v1:/);
  assert.equal(await decryptToken(encrypted), "spotify-access-token");
});

test("stripe payment link carries convex user id as client reference", async () => {
  const { paymentLinkForUser } = await import("../src/services/stripe");

  const url = new URL(paymentLinkForUser("user_123"));

  assert.equal(url.origin, "https://buy.stripe.com");
  assert.equal(url.searchParams.get("client_reference_id"), "user_123");
});

test("pre-spotify link detector requires an explicit link request", async () => {
  const { wantsSpotifyLink } = await import("../src/bot/rotationBot");

  assert.equal(wantsSpotifyLink("send me a fresh spotify link"), true);
  assert.equal(wantsSpotifyLink("can you help me connect spotify"), true);
  assert.equal(wantsSpotifyLink("link spotify"), true);
  assert.equal(wantsSpotifyLink("why do you need spotify?"), false);
  assert.equal(wantsSpotifyLink("how does linking work?"), false);
  assert.equal(wantsSpotifyLink("what can you do before i connect"), false);
});

test("tapback feedback maps only actionable reactions to replies", async () => {
  const { tapbackFeedbackReply } = await import("../src/bot/rotationBot");

  assert.equal(tapbackFeedbackReply("👎"), "noted - tell me what missed and i'll tune the next one.");
  assert.equal(tapbackFeedbackReply("❓"), "what should i clarify?");
  assert.equal(tapbackFeedbackReply("👍"), undefined);
  assert.equal(tapbackFeedbackReply("❤️"), undefined);
});
