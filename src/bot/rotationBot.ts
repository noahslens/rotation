import type { Message, Space, SpectrumInstance } from "spectrum-ts";
import { attachment, contact, poll, richlink, type ContentInput } from "spectrum-ts";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { RotationAi } from "../ai/rotationAi";
import { env } from "../config/env";
import { api, convex } from "../state/convex";
import { billingPortalText, paywallText } from "../services/stripe";
import {
  type CandidateTrack,
  type RotationTrack,
  SpotifyService,
} from "../services/spotify";

const dayMs = 24 * 60 * 60 * 1000;
const weekMs = 7 * dayMs;

type MusicContext = Awaited<ReturnType<typeof convex.query<typeof api.spotify.getMusicContext>>>;

const fallbackCopy = {
  greeting:
    "yo, i'm rotation. i'll make your spotify playlists over text. whether it's finding you new music or helping you rediscover old favs in a pinch.",
  linked:
    "spotify is linked. i'm digesting your taste now and making your first rotation. this takes about 2-4 mins.",
  help:
    "ask for stuff like: “morning run”, “more like my liked songs”, “200 songs i’d fw”, or “gym but not corny”.",
  notLinked: "link spotify first and i can start cooking.",
  error: "my bad, something broke on my side. try that again in a sec.",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTextMessage = (
  message: Message,
): message is Message & { content: { type: "text"; text: string } } =>
  message.content.type === "text";

const outbound = async (userId: Id<"users">, text: string) => {
  await convex.mutation(api.conversation.logTurn, {
    userId,
    direction: "out",
    text,
    now: Date.now(),
  });
};

const sendWithRetry = async (space: Space, content: ContentInput) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await space.send(content);
      return;
    } catch (caught) {
      lastError = caught;
      console.warn("[rotation.send_retry]", {
        attempt,
        error: compactError(caught),
      });
      await sleep(750 * attempt);
    }
  }
  throw lastError;
};

const sendLogged = async (space: Space, userId: Id<"users">, text: string) => {
  await sendWithRetry(space, text);
  await outbound(userId, text);
};

const compactError = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught);

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const greetingPrefix = (text: string) => {
  const clean = normalize(text);
  if (/^(hi|hii|hiii|hiya)\b/.test(clean)) return "hi";
  if (/^(hey|heyy|heyyy)\b/.test(clean)) return "hey";
  if (/^(hello|helloo)\b/.test(clean)) return "hello";
  if (/^(yo|yoo|yooo)\b/.test(clean)) return "yo";
  if (/^(sup|wassup|whats up|what up)\b/.test(clean)) return "sup";
  if (/^(gm|good morning)\b/.test(clean)) return "gm";
  return "yo";
};

const greetingCopy = (text: string) =>
  `${greetingPrefix(text)}, i'm rotation. i'll make your spotify playlists over text. whether it's finding you new music or helping you rediscover old favs in a pinch.`;

const escapeVCardValue = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

const rotationVCard = () => [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:;Rotation;;;",
  "FN:Rotation",
  "ORG:Rotation",
  env.rotationPhone ? `TEL;TYPE=CELL:${env.rotationPhone}` : undefined,
  `NOTE:${escapeVCardValue("spotify playlists over text")}`,
  "END:VCARD",
]
  .filter(Boolean)
  .join("\n");

const resolvePollOption = (text: string, options: string[]) => {
  const clean = normalize(text);
  const numeric = Number.parseInt(clean, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }
  return options.find((option) => {
    const normalizedOption = normalize(option);
    return clean === normalizedOption || clean.includes(normalizedOption);
  });
};

const hasFreshSync = (user: Doc<"users"> | null, context: MusicContext) =>
  Boolean(
    user?.lastSpotifySyncAt &&
      Date.now() - user.lastSpotifySyncAt < dayMs &&
      context.tracks.length > 40,
  );

const uniqueById = <T extends { spotifyTrackId: string }>(tracks: T[]) => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.spotifyTrackId)) return false;
    seen.add(track.spotifyTrackId);
    return true;
  });
};

const newMusicIntent = new Set([
  "discovery",
  "more_like_playlist",
  "more_like_artist",
  "taste_expansion",
]);

const asksForNewMusic = (prompt: string) =>
  /\b(new|discover|discovery|more songs|additional songs|not already|do not already|don't already|havent heard|haven't heard|fresh|put me on|fall in love|layups?)\b/i.test(
    prompt,
  );

const explicitlyAllowsKnownMusic = (prompt: string) =>
  /\b(include|use|add|play|make it|only|all)\b.{0,32}\b(liked|saved|library|familiar|songs i know|stuff i know|favorites?|favourites?)\b/i.test(
    prompt,
  ) ||
  /\b(familiar|comfort songs|songs i already know|my favorites only|my favourites only)\b/i.test(
    prompt,
  );

export const wantsSpotifyLink = (text: string) => {
  const clean = normalize(text);
  if (!clean) return false;

  const requestVerb =
    /\b(send|resend|give|drop|text|make|create|get|need|want)\b.{0,36}\b(fresh|new|another)?\s*(spotify\s+)?(link|auth|login|connect)\b/;
  const conversationalRequest =
    /\b(can you|could you|can i|could i|let me|lemme|help me|i am ready to|im ready to|ready to|trying to|try to)\b.{0,36}\b(link|connect|authorize|auth|reauth|re auth)\b.{0,16}\bspotify\b/;
  const directSpotifyAction =
    /^(link|connect|authorize|auth|reauth|re auth)\b.{0,16}\bspotify\b/;
  const freshLink =
    /\b(fresh|new|another|updated)\b.{0,12}\b(spotify\s+)?(link|auth|login)\b/;
  const retryLink =
    /\b(try again|retry|start over)\b/.test(clean) &&
    /\b(spotify|link|auth|login|connect)\b/.test(clean);

  return (
    requestVerb.test(clean) ||
    conversationalRequest.test(clean) ||
    directSpotifyAction.test(clean) ||
    freshLink.test(clean) ||
    retryLink
  );
};

const shouldUseNewOnly = (args: {
  requestKind: "initial" | "weekly" | "user";
  intent?: string;
  prompt: string;
}) => {
  if (args.requestKind === "initial" || args.requestKind === "weekly") return true;
  if (explicitlyAllowsKnownMusic(args.prompt)) return false;
  return Boolean(
    (args.intent && newMusicIntent.has(args.intent)) || asksForNewMusic(args.prompt),
  );
};

const discoveryScore = (track: CandidateTrack, index: number) => {
  const popularity = track.popularity ?? 45;
  const sweetSpotPenalty = Math.abs(popularity - 52) * 0.7;
  const mainstreamPenalty = popularity > 82 ? (popularity - 82) * 4 : 0;
  const tooObscurePenalty = popularity < 12 ? (12 - popularity) * 1.4 : 0;
  return sweetSpotPenalty + mainstreamPenalty + tooObscurePenalty + index * 0.02;
};

const rankDiscoveryCandidates = (tracks: CandidateTrack[]) =>
  tracks
    .map((track, index) => ({ track, score: discoveryScore(track, index) }))
    .sort((left, right) => left.score - right.score)
    .map(({ track }) => track);

const hasActiveSubscription = (user: Pick<Doc<"users">, "subscriptionStatus">) =>
  user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing";

export class RotationBot {
  constructor(
    private readonly ai: RotationAi,
    private readonly spotify: SpotifyService,
  ) {}

  async handle(space: Space, message: Message) {
    if (!isTextMessage(message) || message.direction === "outbound") return;

    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

    console.info("[rotation.inbound]", {
      platform: message.platform,
      spaceId: space.id,
      sender: platformUserId,
      messageId: message.id,
      text: message.content.text,
    });

    const now = Date.now();
    const user = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!user) return;

    await convex.mutation(api.conversation.logTurn, {
      userId: user._id,
      direction: "in",
      text: message.content.text,
      messageId: message.id,
      now,
    });

    try {
      await message.read().catch((caught) => {
        console.warn("[rotation.read_failed]", compactError(caught));
      });
      await space.startTyping().catch((caught) => {
        console.warn("[rotation.typing_start_failed]", compactError(caught));
      });
      try {
        await this.route(space, user, message.content.text);
      } finally {
        await space.stopTyping().catch((caught) => {
          console.warn("[rotation.typing_stop_failed]", compactError(caught));
        });
      }
    } catch (caught) {
      await this.recordFailure("message_handler", user._id, { text: message.content.text }, caught);
      console.error("[rotation.error]", caught);
      await sendLogged(space, user._id, fallbackCopy.error).catch((sendError) => {
        console.error("[rotation.fallback_send_failed]", sendError);
      });
    }
  }

  async deliverInitialPlaylist(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked || user.initialPlaylistDeliveredAt) return;
    const sendProgress = !user.initialPlaylistStartedAt;
    console.info("[rotation.initial] start", {
      userId: user._id,
      initialPlaylistStartedAt: user.initialPlaylistStartedAt,
    });
    if (!user.initialPlaylistStartedAt) {
      await sendLogged(space, user._id, fallbackCopy.linked);
      await convex.mutation(api.users.markInitialPlaylistStarted, {
        userId: user._id,
        now: Date.now(),
      });
    }
    await this.createPlaylistFromPrompt(space, user, {
      prompt:
        "make my first rotation: 50 new songs that fit my spotify taste. use my liked songs as taste evidence, but do not include songs i already have liked or saved. make it high-confidence layups, not obvious mainstream hits.",
      defaultCount: 50,
      requestKind: "initial",
      sendProgress,
    });
    await convex.mutation(api.users.markInitialPlaylistDelivered, {
      userId: user._id,
      now: Date.now(),
    });
    console.info("[rotation.initial] delivered", { userId: user._id });
    const explainer =
      "how it works: text me a mood, activity, artist, playlist, or “more stuff i’d fw” and i’ll make the playlist.";
    await sendLogged(space, user._id, explainer);
  }

  async deliverWeeklyDiscovery(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked) return;
    await this.createPlaylistFromPrompt(space, user, {
      prompt:
        "weekly rotation: 50 new songs this user would like based on their saved songs, top tracks, and playlists. all picks should be new to their library and feel like high-confidence layups, not obvious mainstream hits.",
      defaultCount: 50,
      requestKind: "weekly",
    });
    await convex.mutation(api.users.setWeeklyDiscoveryDueAt, {
      userId: user._id,
      dueAt: nextWeeklyDueAt(),
      now: Date.now(),
    });
  }

  async maybeAskListeningContext(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked) return;
    const playback = await this.spotify.currentPlayback(user._id).catch(() => null);
    if (!playback?.is_playing) return;

    const session = await convex.mutation(api.listening.upsertSession, {
      userId: user._id,
      spotifyContextUri: playback.context?.uri,
      lastTrackId: playback.item?.id,
      now: Date.now(),
    });

    if (!session || session.askedActivityAt) return;
    if (Date.now() - session.startedAt < 30 * 60 * 1000) return;

    const text =
      "you've been listening for a minute. what are you doing rn? i'll remember the vibe for next time.";
    await sendLogged(space, user._id, text);
    await convex.mutation(api.listening.markAskedActivity, {
      sessionId: session._id,
      now: Date.now(),
    });
  }

  private async route(space: Space, user: Doc<"users">, text: string) {
    if (user.onboardingStage === "new") {
      await this.sendGreeting(space, user, text);
      return;
    }

    if (!user.spotifyLinked) {
      await this.handlePreSpotify(space, user, text);
      return;
    }

    if (!user.initialPlaylistDeliveredAt) {
      await this.deliverInitialPlaylist(space, user);
      const latest = await convex.query(api.users.getById, { userId: user._id });
      if (!latest) return;
      user = latest;
    }

    const pollAnswerHandled = await this.maybeHandlePollAnswer(space, user, text);
    if (pollAnswerHandled) return;

    const intent = await this.ai.classify(text);
    if (intent.intent === "help") {
      const reply = await this.safeReply({ kind: "help", userText: text }, fallbackCopy.help);
      await sendLogged(space, user._id, reply);
      return;
    }

    if (intent.intent === "billing") {
      const reply =
        user.stripeCustomerId || hasActiveSubscription(user)
          ? await billingPortalText(user)
          : paywallText(user._id);
      await sendLogged(space, user._id, reply);
      return;
    }

    if (intent.intent === "smalltalk" && intent.confidence > 0.78) {
      const reply = await this.safeReply({
        kind: "smalltalk",
        userText: text,
      }, "i'm here. send me a vibe and i'll make the playlist.");
      await sendLogged(space, user._id, reply);
      return;
    }

    const shouldGateForPayment =
      Boolean(user.initialPlaylistDeliveredAt) && !hasActiveSubscription(user);
    if (shouldGateForPayment) {
      await sendLogged(
        space,
        user._id,
        paywallText(user._id, { buildingPlaylist: true }),
      );
      await convex.mutation(api.users.markPaywallShown, {
        userId: user._id,
        now: Date.now(),
      });
    }

    await this.createPlaylistFromPrompt(space, user, {
      prompt: text,
      defaultCount: 50,
      requestKind: "user",
      intent: intent.intent,
      deferDeliveryUntilPaid: shouldGateForPayment,
    });
  }

  private async sendGreeting(space: Space, user: Doc<"users">, text: string) {
    await sendLogged(space, user._id, greetingCopy(text));
    const vCard = rotationVCard();
    await sendWithRetry(space, contact(vCard))
      .then(async () => {
        await outbound(user._id, "sent rotation contact card");
      })
      .catch(async (caught) => {
        console.warn("[rotation.contact_card_failed]", compactError(caught));
        await sendWithRetry(
          space,
          attachment(Buffer.from(vCard, "utf8"), {
            name: "Rotation.vcf",
            mimeType: "text/vcard",
          }),
        );
        await outbound(user._id, "sent rotation vcard attachment");
      });
    await convex.mutation(api.users.setOnboardingStage, {
      userId: user._id,
      onboardingStage: "link_sent",
      now: Date.now(),
    });
    await this.sendSpotifyLink(space, user);
  }

  private async handlePreSpotify(space: Space, user: Doc<"users">, text: string) {
    if (wantsSpotifyLink(text)) {
      await this.sendSpotifyLink(space, user);
      return;
    }

    const reply = await this.ai
      .preSpotifyReply(text)
      .catch(
        () =>
          "i can answer questions here, but i need spotify connected before i can make playlists. ask for a fresh link when you're ready.",
      );
    await sendLogged(space, user._id, reply);
  }

  private async sendSpotifyLink(space: Space, user: Doc<"users">, name?: string) {
    const link = await this.spotify.authorizationUrl(user._id);
    const reply = name
      ? `sick, ${name}. connect spotify here so i can get into it`
      : "connect spotify here so i can get into it";
    await sendLogged(space, user._id, reply);
    await sendWithRetry(space, richlink(link));
    await outbound(user._id, link);
  }

  private async maybeHandlePollAnswer(
    space: Space,
    user: Doc<"users">,
    text: string,
  ) {
    const openPoll = await convex.query(api.conversation.getOpenPoll, {
      userId: user._id,
      now: Date.now(),
    });
    if (!openPoll) return false;

    const selectedOption = resolvePollOption(text, openPoll.options);
    if (!selectedOption) {
      const reply = await this.safeReply(
        {
          kind: "poll_repeat",
          userText: text,
          extra: `${openPoll.question}: ${openPoll.options.join(", ")}`,
        },
        `pick one: ${openPoll.options.map((option, index) => `${index + 1}. ${option}`).join(" / ")}`,
      );
      await sendLogged(space, user._id, reply);
      return true;
    }

    await convex.mutation(api.conversation.resolvePendingPoll, {
      pollId: openPoll._id,
      selectedOption,
      now: Date.now(),
    });

    await this.createPlaylistFromPrompt(space, user, {
      prompt: openPoll.originalPrompt,
      pollAnswer: selectedOption,
      defaultCount: 50,
      requestKind: "user",
      deferDeliveryUntilPaid: openPoll.deliveryMode === "after_payment",
    });
    return true;
  }

  private async createPlaylistFromPrompt(
    space: Space,
    user: Doc<"users">,
    args: {
      prompt: string;
      defaultCount: number;
      requestKind: "initial" | "weekly" | "user";
      intent?: string;
      pollAnswer?: string;
      sendProgress?: boolean;
      deferDeliveryUntilPaid?: boolean;
    },
  ) {
    const requestId = await convex.mutation(api.conversation.createRequest, {
      userId: user._id,
      prompt: args.prompt,
      intent: args.intent ?? args.requestKind,
      deliveryMode: args.deferDeliveryUntilPaid ? "after_payment" : "immediate",
      now: Date.now(),
    });

    try {
      const context = await this.freshMusicContext(user);
      if (args.sendProgress) {
        await sendLogged(
          space,
          user._id,
          "your library's deep. taste is way more specific than the usual spotify boxes lol",
        );
      }
      const newOnly = shouldUseNewOnly(args);
      const rawPlan = await this.ai.playlistPlan({
        prompt: args.prompt,
        context,
        defaultCount: args.defaultCount,
        pollAnswer: args.pollAnswer,
        newOnly,
        fixedTargetCount: args.requestKind !== "user",
      });
      const plan =
        args.requestKind === "user"
          ? rawPlan
          : { ...rawPlan, targetCount: args.defaultCount };
      if (args.sendProgress) {
        await sendLogged(
          space,
          user._id,
          "there's a real lane here. digging for stuff that feels like it should already be in your likes.",
        );
      }

      if (plan.needsPoll && plan.pollQuestion && plan.pollOptions?.length && !args.pollAnswer) {
        await convex.mutation(api.conversation.createPendingPoll, {
          userId: user._id,
          originalPrompt: args.prompt,
          deliveryMode: args.deferDeliveryUntilPaid ? "after_payment" : "immediate",
          question: plan.pollQuestion,
          options: plan.pollOptions,
          expiresAt: Date.now() + 30 * 60 * 1000,
          now: Date.now(),
        });
        await space.send(poll(plan.pollQuestion, plan.pollOptions));
        await outbound(
          user._id,
          `${plan.pollQuestion} ${plan.pollOptions.join(" / ")}`,
        );
        return;
      }

      const knownTrackIds = new Set(
        context.tracks.map((track) => track.spotifyTrackId),
      );
      const rawCandidates = await this.spotify.searchTracks(
        user._id,
        plan.searchQueries,
        knownTrackIds,
        Math.min(600, Math.max(240, plan.targetCount * 3)),
      );
      const candidates = newOnly
        ? rankDiscoveryCandidates(rawCandidates)
        : rawCandidates;
      const familiarTracks = newOnly
        ? []
        : this.familiarTracks(context.tracks, plan.familiarTrackIds);
      const selected = await this.selectTracks(
        args.prompt,
        plan,
        candidates,
        familiarTracks,
        newOnly,
      );

      if (selected.length === 0) {
        throw new Error("no tracks selected");
      }

      const playlist = await this.spotify.createPlaylist(user, {
        name: plan.playlistName,
        description: plan.playlistDescription,
        tracks: selected.slice(0, plan.targetCount),
      });

      await convex.mutation(api.conversation.finishRequest, {
        requestId,
        playlistId: playlist.id,
        playlistUrl: playlist.url,
        trackIds: selected.map((track) => track.spotifyTrackId),
        now: Date.now(),
      });

      const reply = await this.safeReply(
        {
          kind: "playlist_ready",
          userText: args.prompt,
          playlistName: playlist.name,
          extra: plan.userFacingSummary,
        },
        `made ${playlist.name}`,
      );
      const latestUser =
        args.deferDeliveryUntilPaid && args.requestKind === "user"
          ? await convex.query(api.users.getById, { userId: user._id })
          : user;
      const canDeliverNow =
        !args.deferDeliveryUntilPaid ||
        (latestUser ? hasActiveSubscription(latestUser) : false);

      if (canDeliverNow) {
        await sendLogged(space, user._id, reply);
        await this.sendPlaylistLink(space, user, playlist.url);
        if (args.deferDeliveryUntilPaid) {
          await convex.mutation(api.conversation.markRequestDelivered, {
            requestId,
            now: Date.now(),
          });
        }
      }

      if (args.requestKind === "user") {
        await convex.mutation(api.users.incrementCompletedRequests, {
          userId: user._id,
          now: Date.now(),
        });
      }
    } catch (caught) {
      await convex.mutation(api.conversation.failRequest, {
        requestId,
        error: compactError(caught),
        now: Date.now(),
      });
      throw caught;
    }
  }

  private async freshMusicContext(user: Doc<"users">) {
    const userId = user._id;
    let context = await this.fullMusicContext(userId);
    if (!hasFreshSync(context.user, context)) {
      console.info("[rotation.context] syncing spotify library", {
        userId,
        existingTracks: context.tracks.length,
      });
      await this.spotify.syncUserLibrary(userId, user.spotifyUserId);
      context = await this.fullMusicContext(userId);
      console.info("[rotation.context] spotify sync loaded", {
        userId,
        tracks: context.tracks.length,
      });
    }

    if (context.user && (!context.user.tasteSummary || !context.user.activityPreferencesJson)) {
      console.info("[rotation.context] summarizing taste", {
        userId,
        tracks: context.tracks.length,
      });
      const summary = await this.ai.summarizeTaste(context);
      await convex.mutation(api.users.updateTasteSummary, {
        userId,
        tasteSummary: summary.tasteSummary,
        activityPreferencesJson: summary.activityPreferences
          ? JSON.stringify(summary.activityPreferences)
          : undefined,
        now: Date.now(),
      });
      context = await this.fullMusicContext(userId);
    }

    return context;
  }

  private async fullMusicContext(userId: Id<"users">): Promise<MusicContext> {
    const context = await convex.query(api.spotify.getMusicContext, { userId });
    const [savedTracks, topTracks, playlistTracks, createdTracks] =
      await Promise.all([
        this.fetchTracksBySource(userId, "saved"),
        this.fetchTracksBySource(userId, "top"),
        this.fetchTracksBySource(userId, "playlist"),
        this.fetchTracksBySource(userId, "created"),
      ]);
    return {
      ...context,
      tracks: uniqueById([
        ...savedTracks,
        ...topTracks,
        ...playlistTracks,
        ...createdTracks,
      ]),
    };
  }

  private async fetchTracksBySource(
    userId: Id<"users">,
    source: RotationTrack["source"],
  ) {
    const tracks: Doc<"spotifyTracks">[] = [];
    let cursor: string | null = null;

    do {
      const page: {
        page: Doc<"spotifyTracks">[];
        isDone: boolean;
        continueCursor: string;
      } = await convex.query(api.spotify.getTracksBySourcePage, {
        userId,
        source,
        paginationOpts: {
          numItems: 1_000,
          cursor,
        },
      });
      tracks.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);

    if (tracks.length) {
      console.info("[rotation.context] fetched source tracks", {
        userId,
        source,
        count: tracks.length,
      });
    }
    return tracks;
  }

  private familiarTracks(
    tracks: Doc<"spotifyTracks">[],
    preferredTrackIds: string[],
  ): RotationTrack[] {
    const byId = new Map(tracks.map((track) => [track.spotifyTrackId, track]));
    const preferred = preferredTrackIds
      .map((id) => byId.get(id))
      .filter((track): track is Doc<"spotifyTracks"> => Boolean(track));
    const fallback = tracks
      .filter((track) => track.source === "saved" || track.source === "top")
      .slice(0, 200);
    return uniqueById([...preferred, ...fallback]).map((track) => ({
      spotifyTrackId: track.spotifyTrackId,
      name: track.name,
      artists: track.artists,
      album: track.album,
      uri: track.uri,
      externalUrl: track.externalUrl,
      popularity: track.popularity,
      durationMs: track.durationMs,
      explicit: track.explicit,
      previewUrl: track.previewUrl,
      source: track.source,
      playlistIds: track.playlistIds,
    }));
  }

  private async selectTracks(
    prompt: string,
    plan: Awaited<ReturnType<RotationAi["playlistPlan"]>>,
    candidates: CandidateTrack[],
    familiarTracks: RotationTrack[],
    newOnly: boolean,
  ) {
    const chosen = await this.ai.chooseTracks({
      prompt,
      plan,
      candidates,
      familiarTracks,
      newOnly,
    });
    const byId = new Map<string, RotationTrack>();
    for (const track of (newOnly ? candidates : [...candidates, ...familiarTracks])) {
      byId.set(track.spotifyTrackId, track);
    }

    const selected = chosen.selectedTrackIds
      .map((id) => byId.get(id))
      .filter((track): track is RotationTrack => Boolean(track));

    const filled = newOnly
      ? uniqueById([...selected, ...candidates.slice(0, plan.targetCount)])
      : uniqueById([
          ...selected,
          ...candidates.slice(0, plan.targetCount),
          ...familiarTracks.slice(0, Math.max(5, Math.floor(plan.targetCount * 0.15))),
        ]);
    return filled.slice(0, plan.targetCount);
  }

  private async maybeSendPaywall(space: Space, user: Doc<"users">) {
    if (!user.hasSeenPaywall && user.completedRequestCount === 0) {
      await sendLogged(space, user._id, paywallText(user._id));
      await convex.mutation(api.users.markPaywallShown, {
        userId: user._id,
        now: Date.now(),
      });
    }
    await convex.mutation(api.users.incrementCompletedRequests, {
      userId: user._id,
      now: Date.now(),
    });
  }

  private async sendPlaylistLink(space: Space, user: Doc<"users">, url: string) {
    await sendWithRetry(space, richlink(url));
    await outbound(user._id, url);
  }

  async deliverBillingNotification(
    space: Space,
    user: Doc<"users">,
    request?: Doc<"recommendationRequests"> | null,
  ) {
    await sendLogged(
      space,
      user._id,
      "welcome to rotation. you can manage your subscription here over text.",
    );

    const readyRequest =
      request && request.status === "completed" && request.playlistUrl && !request.deliveredAt
        ? request
        : await convex.query(api.conversation.latestUndeliveredPaidRequest, {
            userId: user._id,
          });

    if (readyRequest?.playlistUrl) {
      await sendLogged(space, user._id, "your playlist is ready.");
      await this.sendPlaylistLink(space, user, readyRequest.playlistUrl);
      await convex.mutation(api.conversation.markRequestDelivered, {
        requestId: readyRequest._id,
        now: Date.now(),
      });
    } else {
      await sendLogged(
        space,
        user._id,
        "i'm still finishing that playlist. i'll send it here as soon as it's ready.",
      );
    }
  }

  private async safeReply(
    args: Parameters<RotationAi["shortReply"]>[0],
    fallback: string,
  ) {
    return await this.ai.shortReply(args).catch(() => fallback);
  }

  private async recordFailure(
    job: string,
    userId: Id<"users">,
    payload: unknown,
    caught: unknown,
  ) {
    await convex.mutation(api.conversation.recordJobFailure, {
      job,
      userId,
      payloadJson: JSON.stringify(payload).slice(0, 4000),
      error: compactError(caught),
      now: Date.now(),
    });
  }
}

export const createRotationBot = () =>
  new RotationBot(new RotationAi(), new SpotifyService());

export type RotationApp = SpectrumInstance;

export const nextWeeklyDueAt = () => Date.now() + weekMs;
