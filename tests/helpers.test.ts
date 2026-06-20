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

test("spotify auth requests playlist cover upload permission", async () => {
  const { spotifyScopes } = await import("../src/services/spotify");

  assert.equal(spotifyScopes.includes("ugc-image-upload"), true);
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

test("playlist link resend detector avoids spotify auth links", async () => {
  const { wantsPlaylistLinkResend } = await import("../src/bot/rotationBot");

  assert.equal(wantsPlaylistLinkResend("can you send it again"), true);
  assert.equal(wantsPlaylistLinkResend("playlist link didn't go through"), true);
  assert.equal(wantsPlaylistLinkResend("no preview showed up"), true);
  assert.equal(wantsPlaylistLinkResend("send me a fresh spotify link"), false);
  assert.equal(wantsPlaylistLinkResend("can i connect spotify again"), false);
  assert.equal(wantsPlaylistLinkResend("make another pool party playlist"), false);
});

test("voice note detector handles inbound audio attachments", async () => {
  const { voiceNotesFromMessage } = await import("../src/bot/rotationBot");
  const message = {
    id: "message_1",
    content: {
      type: "attachment",
      id: "attachment_1",
      name: "voice.m4a",
      mimeType: "audio/mp4",
      size: 123,
    },
  };
  const space = { phone: "+15555550123" };
  const notes = voiceNotesFromMessage(message as never, space as never, {
    getAttachment: async (id, phone) => {
      assert.equal(id, "attachment_1");
      assert.equal(phone, "+15555550123");
      return {
        type: "attachment",
        id,
        name: "voice.m4a",
        mimeType: "audio/mp4",
        read: async () => Buffer.from("audio bytes"),
      };
    },
  });

  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.mimeType, "audio/mp4");
  assert.deepEqual(await notes[0]?.read(), Buffer.from("audio bytes"));
});

test("voice note detector ignores non-audio attachments", async () => {
  const { voiceNotesFromMessage } = await import("../src/bot/rotationBot");

  const notes = voiceNotesFromMessage(
    {
      id: "message_1",
      content: {
        type: "attachment",
        id: "attachment_1",
        name: "photo.jpg",
        mimeType: "image/jpeg",
      },
    } as never,
    {} as never,
  );

  assert.equal(notes.length, 0);
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
    { reaction: "🔥", message: "check this https://Example.com/ABC" },
  );
  assert.deepEqual(
    formatTextingAction({
      mode: "message_only",
      reaction: "fire",
      message: "🔥 checking now",
    }),
    { reaction: "🔥", message: "checking now" },
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

test("playlist ready formatter removes inline links and repeated reaction emoji", async () => {
  const { formatPlaylistReadyReply } = await import("../src/bot/rotationBot");

  assert.equal(
    formatPlaylistReadyReply(
      "made pool party 🔥 https://open.spotify.com/playlist/abc",
      "made pool party",
      "fire",
    ),
    "made pool party",
  );
});

test("explicit opener is moved first without deduping same-title tracks", async () => {
  const { explicitOpenerQuery, finalizeSelectedTracks } = await import("../src/bot/rotationBot");
  const skyfall = {
    spotifyTrackId: "skyfall_adele",
    name: "Skyfall",
    artists: ["Adele"],
    uri: "spotify:track:skyfall_adele",
    source: "recommendation" as const,
  };
  const moonRiverOne = {
    spotifyTrackId: "moon_river_1",
    name: "Moon River",
    artists: ["Frank Ocean"],
    uri: "spotify:track:moon_river_1",
    source: "recommendation" as const,
  };
  const moonRiverTwo = {
    spotifyTrackId: "moon_river_2",
    name: "Moon River",
    artists: ["Andy Williams"],
    uri: "spotify:track:moon_river_2",
    source: "recommendation" as const,
  };

  const opener = explicitOpenerQuery(
    "late night rainy vibe playlist. first track skyfall adele",
  );
  const finalized = finalizeSelectedTracks(
    [moonRiverOne, moonRiverTwo],
    [moonRiverOne, moonRiverTwo, skyfall],
    opener,
  );

  assert.equal(opener, "skyfall adele");
  assert.deepEqual(
    finalized.map((track) => track.spotifyTrackId),
    ["skyfall_adele", "moon_river_1", "moon_river_2"],
  );
});
