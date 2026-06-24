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
  assert.match(text, /i'll make that playlist next/);
  assert.match(text, /4242 4242 4242 4242/);
  assert.match(text, /any exp \+ cvv/);
  assert.equal(text.includes("https://"), false);
  assert.equal(text.includes("ready by the time"), false);
});

test("stripe payment links use richlinks instead of inline urls", async () => {
  const { stripePaymentLinkContent } = await import("../src/bot/rotationBot");
  const built = await (
    stripePaymentLinkContent("user_123") as {
      build: () => Promise<{ type: string; url: string }>;
    }
  ).build();

  assert.equal(built.type, "richlink");
  assert.equal(built.url, "https://buy.stripe.com/test_abc123?client_reference_id=user_123");
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

test("playlist links use web richlinks instead of spectrum app cards", async () => {
  const { playlistLinkContent } = await import("../src/bot/rotationBot");
  const built = await (
    playlistLinkContent("https://open.spotify.com/playlist/abc123") as {
      build: () => Promise<{ type: string; url: string }>;
    }
  ).build();

  assert.equal(built.type, "richlink");
  assert.equal(built.url, "https://open.spotify.com/playlist/abc123");
});

test("playlist vote poll options are compact and ordered", async () => {
  const { playlistVoteOptions } = await import("../src/bot/rotationBot");

  assert.deepEqual(
    playlistVoteOptions([
      "first extremely long playlist name that should not crush the poll",
      "short one",
    ]),
    ["first: first extremely long", "second: short one"],
  );
});

test("playlist generation is gemini only", async () => {
  const { playlistProviders } = await import("../src/bot/rotationBot");

  assert.deepEqual(playlistProviders(), ["gemini"]);
});

test("spotify rate limits use a specific fallback message", async () => {
  const { fallbackErrorMessage } = await import("../src/bot/rotationBot");

  assert.match(
    fallbackErrorMessage(new Error("spotify rate limited: retry after 47560s")),
    /spotify is rate-limiting/i,
  );
  assert.notEqual(
    fallbackErrorMessage(new Error("spotify rate limited: retry after 47560s")),
    "my bad, something broke on my side. try that again in a sec.",
  );
});

test("native poll option messages are treated as text answers", async () => {
  const { textFromMessage } = await import("../src/bot/rotationBot");

  const message = {
    content: {
      type: "poll_option",
      title: "50% current",
      option: { title: "50% current" },
      selected: true,
    },
  };

  assert.equal(textFromMessage(message as any), "50% current");
});

test("playlist ready copy is skipped when sending variants", async () => {
  const { shouldSendPlaylistReadyReply } = await import("../src/bot/rotationBot");

  assert.equal(shouldSendPlaylistReadyReply(0), true);
  assert.equal(shouldSendPlaylistReadyReply(1), true);
  assert.equal(shouldSendPlaylistReadyReply(2), false);
});

test("initial playlists use a planner target and fallback backfill", async () => {
  const {
    initialPlaylistBackfillPickCount,
    initialPlaylistDescription,
    initialPlaylistDeliveryMax,
    initialPlaylistModelCount,
    initialPlaylistName,
  } = await import("../src/bot/rotationBot");

  assert.equal(initialPlaylistModelCount, 90);
  assert.equal(initialPlaylistBackfillPickCount, 90);
  assert.equal(initialPlaylistDeliveryMax, 75);
  assert.equal(initialPlaylistName, "first rotation");
  assert.match(initialPlaylistDescription, /broad mix/);
  assert.ok(initialPlaylistModelCount > initialPlaylistDeliveryMax);
  assert.ok(initialPlaylistBackfillPickCount >= initialPlaylistModelCount);
});

test("playlist edit detector handles edits without stealing more-like requests", async () => {
  const { playlistEditIntent, spotifyPlaylistIdFromText } = await import("../src/bot/rotationBot");

  assert.equal(playlistEditIntent("add more future to it"), true);
  assert.equal(playlistEditIntent("add 10 more songs to that playlist"), true);
  assert.equal(playlistEditIntent("add 20 more songs pls"), true);
  assert.equal(playlistEditIntent("30 more songs pls"), true);
  assert.equal(playlistEditIntent("remove skyfall from that playlist"), true);
  assert.equal(playlistEditIntent("make it more upbeat"), true);
  assert.equal(
    playlistEditIntent("give me more songs like my summer playlist"),
    false,
  );
  assert.equal(
    playlistEditIntent("give me more songs like https://open.spotify.com/playlist/abc123"),
    false,
  );
  assert.equal(
    spotifyPlaylistIdFromText("https://open.spotify.com/playlist/abc123?si=xyz"),
    "abc123",
  );
});

test("direct playlist request detector catches explicit playlist creation", async () => {
  const { directPlaylistRequest } = await import("../src/bot/rotationBot");

  assert.equal(
    directPlaylistRequest("Make me a going out playlist for pregames")?.intent,
    "activity_playlist",
  );
  assert.equal(
    directPlaylistRequest("more stuff i'd fw")?.intent,
    "discovery",
  );
  assert.equal(directPlaylistRequest("how much does rotation cost"), null);
});

test("playlist auto delete parser handles short and long durations", async () => {
  const { playlistAutoDeleteRequest } = await import("../src/bot/rotationBot");
  const now = Date.UTC(2026, 5, 20);

  assert.deepEqual(playlistAutoDeleteRequest("1d", now), {
    durationMs: 24 * 60 * 60 * 1000,
    deleteAt: now + 24 * 60 * 60 * 1000,
    label: "1 day",
  });
  assert.deepEqual(playlistAutoDeleteRequest("36h", now), {
    durationMs: 36 * 60 * 60 * 1000,
    deleteAt: now + 36 * 60 * 60 * 1000,
    label: "36 hours",
  });
  assert.deepEqual(playlistAutoDeleteRequest("after 36h please", now), {
    durationMs: 36 * 60 * 60 * 1000,
    deleteAt: now + 36 * 60 * 60 * 1000,
    label: "36 hours",
  });
  assert.deepEqual(playlistAutoDeleteRequest("2w", now), {
    durationMs: 14 * 24 * 60 * 60 * 1000,
    deleteAt: now + 14 * 24 * 60 * 60 * 1000,
    label: "2 weeks",
  });
  assert.deepEqual(playlistAutoDeleteRequest("delete after 2 weeks", now), {
    durationMs: 14 * 24 * 60 * 60 * 1000,
    deleteAt: now + 14 * 24 * 60 * 60 * 1000,
    label: "2 weeks",
  });
  assert.equal(playlistAutoDeleteRequest("make me a 1 hour run playlist", now), null);
  assert.equal(playlistAutoDeleteRequest("don't delete after 1 day", now), null);
});

test("playlist working reaction falls back for generation requests", async () => {
  const { playlistWorkingReaction } = await import("../src/bot/rotationBot");

  assert.equal(
    playlistWorkingReaction("morning run playlist", "activity_playlist"),
    "🏃",
  );
  assert.equal(
    playlistWorkingReaction("late night rainy playlist", "activity_playlist"),
    "🌧️",
  );
  assert.equal(
    playlistWorkingReaction("give me 200 new songs i'd fw", "discovery"),
    "🎧",
  );
  assert.equal(
    playlistWorkingReaction("what does this cost", "billing"),
    undefined,
  );
  assert.equal(
    playlistWorkingReaction("gym playlist", "activity_playlist", "fire"),
    "🔥",
  );
});

test("carryover ambiguity poll catches recent mood plus new short theme", async () => {
  const { carryoverAmbiguityPoll } = await import("../src/bot/rotationBot");
  const now = Date.UTC(2026, 5, 20, 12);
  const history = [
    {
      direction: "in",
      text: "sad playlist",
      createdAt: now - 5 * 60 * 1000,
    },
    {
      direction: "out",
      text: "made sad",
      createdAt: now - 4 * 60 * 1000,
    },
    {
      direction: "in",
      text: "london playlist",
      createdAt: now,
    },
  ] as const;

  assert.deepEqual(
    carryoverAmbiguityPoll("london playlist", [...history], "activity_playlist", now),
    {
      question: "for london, should i keep sad from earlier?",
      options: ["london only", "sad london"],
    },
  );
  assert.equal(
    carryoverAmbiguityPoll("same london playlist", [...history], "activity_playlist", now),
    null,
  );
  assert.equal(
    carryoverAmbiguityPoll("gym playlist", [...history], "activity_playlist", now),
    null,
  );
  assert.equal(
    carryoverAmbiguityPoll("london playlist", [...history], "billing", now),
    null,
  );
  assert.equal(
    carryoverAmbiguityPoll(
      "london playlist",
      [
        {
          direction: "in",
          text: "sad playlist",
          createdAt: now - 20 * 60 * 1000,
        },
      ],
      "activity_playlist",
      now,
    ),
    null,
  );
});

test("familiar mix poll asks on broad activity playlists only", async () => {
  const { familiarMixPercent, familiarMixPoll } = await import("../src/bot/rotationBot");

  assert.deepEqual(familiarMixPoll("lifting playlist", "activity_playlist"), {
    question: "how much should be songs you already know?",
    options: ["25% current", "50% current", "75% current", "100% current"],
  });
  assert.equal(familiarMixPoll("10 song lifting playlist", "activity_playlist"), null);
  assert.equal(familiarMixPoll("new lifting playlist", "activity_playlist"), null);
  assert.equal(familiarMixPoll("lifting playlist 75% current", "activity_playlist"), null);
  assert.equal(familiarMixPoll("songs i'd fw", "discovery"), null);
  assert.equal(familiarMixPercent("50% current"), 50);
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

test("photo upload acknowledgement distinguishes first and later photos", async () => {
  const { photoUploadAck } = await import("../src/bot/rotationBot");

  assert.deepEqual(
    photoUploadAck({
      existingPhotoCount: 0,
      incomingCount: 1,
      savedCount: 1,
      failureCount: 0,
    }),
    { message: "saved it." },
  );
  assert.deepEqual(
    photoUploadAck({
      existingPhotoCount: 1,
      incomingCount: 1,
      savedCount: 1,
      failureCount: 0,
    }),
    { reaction: "✅" },
  );
  assert.deepEqual(
    photoUploadAck({
      existingPhotoCount: 1,
      incomingCount: 3,
      savedCount: 3,
      failureCount: 0,
    }),
    { message: "saved 3 pics" },
  );
  assert.deepEqual(
    photoUploadAck({
      existingPhotoCount: 1,
      incomingCount: 2,
      savedCount: 1,
      failureCount: 1,
    }),
    { message: "saved 1 pic. 1 didn't come through." },
  );
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
      mode: "message_only",
      reaction: "fire",
      message: "🔥 checking now",
    }),
    { reaction: undefined, message: "🔥 checking now" },
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
  assert.equal(
    formatPlaylistReadyReply(
      "on it. built the warmup. check the top of your library in a second.",
      "made the warmup",
    ),
    "on it. built the warmup.",
  );
  assert.equal(
    formatPlaylistReadyReply(
      "just spun up your first off-grid rotation. 75 fresh, deep cuts built from your taste but nothing you already know.",
      "made your first rotation",
    ),
    "just spun up your first off-grid rotation. fresh, deep cuts built from your taste but nothing you already know.",
  );
});

test("delayed progress formatter says almost done once", async () => {
  const { formatDelayedProgressMessage, formatReadySoonProgressMessage } =
    await import("../src/bot/rotationBot");

  assert.equal(
    formatDelayedProgressMessage("your garage-rock thread is weirdly locked in"),
    "your garage-rock thread is weirdly locked in. almost done.",
  );
  assert.equal(
    formatDelayedProgressMessage("already almost done."),
    "already almost done.",
  );
  assert.equal(
    formatReadySoonProgressMessage("your garage-rock thread is weirdly locked in"),
    "your garage-rock thread is weirdly locked in. it'll be ready soon.",
  );
  assert.equal(
    formatReadySoonProgressMessage("still working. it'll be ready soon."),
    "still working. it'll be ready soon.",
  );
});

test("initial playlist background retries cool down started jobs", async () => {
  const { initialRetryCooldownMs, shouldProcessInitialPlaylist } = await import(
    "../src/bot/background"
  );
  const now = 10_000_000;

  assert.equal(shouldProcessInitialPlaylist({ onboardingStage: "linked" }, now), true);
  assert.equal(shouldProcessInitialPlaylist({ onboardingStage: "new" }, now), false);
  assert.equal(
    shouldProcessInitialPlaylist(
      { onboardingStage: "linked", initialPlaylistDeliveredAt: now - 1 },
      now,
    ),
    false,
  );
  assert.equal(
    shouldProcessInitialPlaylist(
      { onboardingStage: "linked", initialPlaylistStartedAt: now - 30_000 },
      now,
    ),
    false,
  );
  assert.equal(
    shouldProcessInitialPlaylist(
      {
        onboardingStage: "linked",
        initialPlaylistStartedAt: now - initialRetryCooldownMs - 1,
      },
      now,
    ),
    true,
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

test("known library filter removes alternate ids for existing songs", async () => {
  const { filterKnownLibraryTracks } = await import("../src/bot/rotationBot");
  const library = [
    {
      spotifyTrackId: "saved_1",
      name: "Earrings",
      artists: ["Malcolm Todd"],
    },
    {
      spotifyTrackId: "saved_2",
      name: "Moon River",
      artists: ["Frank Ocean"],
    },
  ];
  const candidates = [
    {
      spotifyTrackId: "alt_earrings",
      name: "Earrings - Single Version",
      artists: ["Malcolm Todd"],
      uri: "spotify:track:alt_earrings",
      source: "recommendation" as const,
    },
    {
      spotifyTrackId: "andy_moon_river",
      name: "Moon River",
      artists: ["Andy Williams"],
      uri: "spotify:track:andy_moon_river",
      source: "recommendation" as const,
    },
    {
      spotifyTrackId: "new_song",
      name: "Something New",
      artists: ["Malcolm Todd"],
      uri: "spotify:track:new_song",
      source: "recommendation" as const,
    },
  ];

  assert.deepEqual(
    filterKnownLibraryTracks(candidates, library).map((track) => track.spotifyTrackId),
    ["andy_moon_river", "new_song"],
  );
});

test("playlist track uniqueness removes same artist title variants", async () => {
  const { uniquePlaylistTracks } = await import("../src/bot/rotationBot");
  const tracks = [
    {
      spotifyTrackId: "trap_jump_explicit",
      name: "Trap Jump",
      artists: ["Ken Carson"],
      uri: "spotify:track:trap_jump_explicit",
      source: "recommendation" as const,
    },
    {
      spotifyTrackId: "trap_jump_clean",
      name: "Trap Jump - Clean",
      artists: ["Ken Carson"],
      uri: "spotify:track:trap_jump_clean",
      source: "recommendation" as const,
    },
    {
      spotifyTrackId: "moon_river_frank",
      name: "Moon River",
      artists: ["Frank Ocean"],
      uri: "spotify:track:moon_river_frank",
      source: "recommendation" as const,
    },
    {
      spotifyTrackId: "moon_river_andy",
      name: "Moon River",
      artists: ["Andy Williams"],
      uri: "spotify:track:moon_river_andy",
      source: "recommendation" as const,
    },
  ];

  assert.deepEqual(
    uniquePlaylistTracks(tracks).map((track) => track.spotifyTrackId),
    ["trap_jump_explicit", "moon_river_frank", "moon_river_andy"],
  );
});

test("playlist diversity caps albums and artists", async () => {
  const { enforcePlaylistDiversity } = await import("../src/bot/rotationBot");
  const tracks = [
    ["a1", "Song 1", "Artist A", "Album A"],
    ["a2", "Song 2", "Artist A", "Album A"],
    ["a3", "Song 3", "Artist A", "Album A"],
    ["a4", "Song 4", "Artist A", "Album B"],
    ["a5", "Song 5", "Artist A", "Album C"],
    ["b1", "Song 6", "Artist B", "Album D"],
  ].map(([spotifyTrackId, name, artist, album]) => ({
    spotifyTrackId,
    name,
    artists: [artist],
    album,
    uri: `spotify:track:${spotifyTrackId}`,
    source: "recommendation" as const,
  }));

  assert.deepEqual(
    enforcePlaylistDiversity(tracks, { maxPerAlbum: 2, maxPerArtist: 4 }).map(
      (track) => track.spotifyTrackId,
    ),
    ["a1", "a2", "a4", "a5", "b1"],
  );
});

test("gemini initial discovery review repairs narrow first rotation plans", async () => {
  const {
    applyInitialDiscoveryPlanReview,
    geminiInitialDiscoveryPlannerGuard,
  } = await import("../src/ai/rotationAi");

  assert.match(geminiInitialDiscoveryPlannerGuard, /broad personal discovery mix/);

  const reviewed = applyInitialDiscoveryPlanReview(
    {
      needsPoll: false,
      playlistName: "headlights",
      playlistDescription: "late night drive songs",
      targetCount: 75,
      songPicks: ["kavinsky - nightcall", "tame impala - alter ego"],
      searchQueries: [],
      familiarTrackIds: [],
      vibe: "late night drive",
      userFacingSummary: "made a late night drive playlist.",
    },
    {
      passes: false,
      reason: "too focused on one setting",
      revisedPlaylistName: "first rotation",
      revisedPlaylistDescription: "broad discovery from the user's taste",
      revisedUserFacingSummary: "first rotation is ready. lmk what you think.",
      songPicksToDrop: ["kavinsky - nightcall"],
      songPickAdditions: ["kelela - bank head", "young nudy - spaced out"],
    },
  );

  assert.equal(reviewed.playlistName, "first rotation");
  assert.deepEqual(reviewed.songPicks, [
    "tame impala - alter ego",
    "kelela - bank head",
    "young nudy - spaced out",
  ]);
});

test("song pick spotify helpers parse and score intended tracks", async () => {
  const {
    parseSongPick,
    songPickToSpotifyQuery,
    spotifySongMatchScore,
  } = await import("../src/services/spotify");

  assert.deepEqual(parseSongPick("Frank Ocean - DHL"), {
    artist: "Frank Ocean",
    title: "DHL",
    text: "Frank Ocean - DHL",
  });
  assert.equal(songPickToSpotifyQuery("Frank Ocean - DHL"), "track:DHL artist:Frank Ocean");

  const exactScore = spotifySongMatchScore("Frank Ocean - DHL", {
    name: "DHL",
    artists: ["Frank Ocean"],
    album: "DHL",
    popularity: 67,
  });
  const badScore = spotifySongMatchScore("Frank Ocean - DHL", {
    name: "Nights",
    artists: ["Avicii"],
    album: "True",
    popularity: 80,
  });

  assert.ok(exactScore > 0.85);
  assert.ok(badScore < 0.45);
});

test("spotify playlist descriptions strip song counts", async () => {
  const { spotifyDescriptionText } = await import("../src/services/spotify");

  assert.equal(
    spotifyDescriptionText(
      "90 picks built off your actual taste. moody bedroom pop and nocturnal trap.",
    ),
    "built off your actual taste. moody bedroom pop and nocturnal trap.",
  );
  assert.equal(
    spotifyDescriptionText("75 songs, no obvious hits, just adjacent gold."),
    "no obvious hits, just adjacent gold.",
  );
  assert.equal(
    spotifyDescriptionText("seventy-five deep cuts built off your actual taste."),
    "built off your actual taste.",
  );
});
