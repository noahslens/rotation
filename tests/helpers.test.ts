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

test("paywall text includes stripe test card dev note", async () => {
  const { paywallText } = await import("../src/services/stripe");

  const text = paywallText("user_123", { buildingPlaylist: true });

  assert.match(text, /\$29\.99\/y/);
  assert.match(text, /4242 4242 4242 4242/);
  assert.match(text, /any exp \+ cvv/);
  assert.match(text, /ready by the time you're done/);
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

test("unsupported service detector answers onboarding support questions only", async () => {
  const { unsupportedMusicServiceReply } = await import("../src/bot/rotationBot");

  const reply = unsupportedMusicServiceReply("do you support apple music?");

  assert.match(reply ?? "", /not yet/);
  assert.match(reply ?? "", /spotify is the only one live rn/);
  assert.match(reply ?? "", /text you when they're ready/);
  assert.equal(
    unsupportedMusicServiceReply("i like soundcloud rap"),
    undefined,
  );
  assert.equal(
    unsupportedMusicServiceReply("can i use yt music instead"),
    reply,
  );
});

test("tapback feedback maps only actionable reactions to replies", async () => {
  const { tapbackFeedbackReply } = await import("../src/bot/rotationBot");

  assert.equal(tapbackFeedbackReply("👎"), "noted - tell me what missed and i'll tune the next one.");
  assert.equal(tapbackFeedbackReply("❓"), "what should i clarify?");
  assert.equal(tapbackFeedbackReply("👍"), undefined);
  assert.equal(tapbackFeedbackReply("❤️"), undefined);
});

test("reaction formatter normalizes model aliases and rejects plain text", async () => {
  const { normalizeReaction } = await import("../src/bot/rotationBot");

  assert.equal(normalizeReaction("love"), "❤️");
  assert.equal(normalizeReaction(":running:"), "🏃");
  assert.equal(normalizeReaction("lock in"), "🔒");
  assert.equal(normalizeReaction("🔥"), "🔥");
  assert.equal(normalizeReaction("not a reaction"), undefined);
});

test("texting action formatter supports reaction only, message only, and both", async () => {
  const { formatTextingAction } = await import("../src/bot/rotationBot");

  assert.deepEqual(
    formatTextingAction({
      mode: "reaction_only",
      reaction: "heart",
      message: "THANK YOU",
    }),
    { reaction: "❤️", message: undefined },
  );
  assert.deepEqual(
    formatTextingAction({
      mode: "message_only",
      reaction: "fire",
      message: "CHECK THIS https://Example.com/ABC",
    }),
    { reaction: undefined, message: "check this https://Example.com/ABC" },
  );
  assert.deepEqual(
    formatTextingAction({
      mode: "both",
      reaction: "gym",
      message: "ON IT",
    }),
    { reaction: "🏋️", message: "on it" },
  );
  assert.deepEqual(
    formatTextingAction({
      mode: "both",
      reaction: "fire",
      message: "🔥 on it",
    }),
    { reaction: "🔥", message: "on it" },
  );
  assert.deepEqual(
    formatTextingAction({
      mode: "both",
      reaction: "fire",
      message: "🔥",
    }),
    { reaction: "🔥", message: undefined },
  );
});
