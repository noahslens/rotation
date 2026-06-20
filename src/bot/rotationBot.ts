import type { Message, Space, SpectrumInstance } from "spectrum-ts";
import { poll } from "spectrum-ts";
import { nativeContactCard } from "@spectrum-ts/imessage";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { RotationAi } from "../ai/rotationAi";
import { api, convex } from "../state/convex";
import { paywallText } from "../services/stripe";
import {
  type CandidateTrack,
  type RotationTrack,
  SpotifyService,
} from "../services/spotify";

const dayMs = 24 * 60 * 60 * 1000;
const weekMs = 7 * dayMs;

type MusicContext = Awaited<ReturnType<typeof convex.query<typeof api.spotify.getMusicContext>>>;

const fallbackCopy = {
  greeting: "yo, i'm rotation. i'll make spotify playlists over text. what should i call you?",
  linked:
    "spotify is linked. i'm reading your taste now and making your first rotation.",
  help:
    "ask for stuff like: “morning run”, “more like my liked songs”, “200 songs i’d fw”, or “gym but not corny”.",
  notLinked: "link spotify first and i can start cooking.",
  error: "my bad, something broke on my side. try that again in a sec.",
};

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

const sendLogged = async (space: Space, userId: Id<"users">, text: string) => {
  await space.send(text);
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

export class RotationBot {
  constructor(
    private readonly ai: RotationAi,
    private readonly spotify: SpotifyService,
  ) {}

  async handle(space: Space, message: Message) {
    if (!isTextMessage(message) || message.direction === "outbound") return;

    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

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
      await space.responding(async () => {
        await this.route(space, user, message.content.text);
      });
    } catch (caught) {
      await this.recordFailure("message_handler", user._id, { text: message.content.text }, caught);
      await sendLogged(space, user._id, fallbackCopy.error);
    }
  }

  async deliverInitialPlaylist(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked || user.initialPlaylistDeliveredAt) return;
    await sendLogged(space, user._id, fallbackCopy.linked);
    await this.createPlaylistFromPrompt(space, user, {
      prompt:
        "make my first rotation: 50 new songs that fit my spotify taste, with a few familiar anchors",
      defaultCount: 50,
      requestKind: "initial",
    });
    await convex.mutation(api.users.markInitialPlaylistDelivered, {
      userId: user._id,
      now: Date.now(),
    });
    const explainer =
      "how it works: text me a mood, activity, artist, playlist, or “more stuff i’d fw” and i’ll make the playlist.";
    await sendLogged(space, user._id, explainer);
  }

  async deliverWeeklyDiscovery(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked) return;
    await this.createPlaylistFromPrompt(space, user, {
      prompt:
        "weekly rotation: 50 new songs this user would like based on their saved songs, top tracks, and playlists",
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
      await this.sendGreeting(space, user);
      return;
    }

    if (!user.preferredName && user.onboardingStage === "asked_name") {
      await this.captureNameAndSendSpotifyLink(space, user, text);
      return;
    }

    if (!user.spotifyLinked) {
      await this.sendSpotifyLink(space, user);
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
      await sendLogged(space, user._id, paywallText(user._id));
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

    await this.createPlaylistFromPrompt(space, user, {
      prompt: text,
      defaultCount: 50,
      requestKind: "user",
      intent: intent.intent,
    });
  }

  private async sendGreeting(space: Space, user: Doc<"users">) {
    const greeting = await this.safeReply(
      { kind: "greeting" },
      fallbackCopy.greeting,
    );
    await sendLogged(space, user._id, greeting);
    await space.send(nativeContactCard());
    await convex.mutation(api.users.setOnboardingStage, {
      userId: user._id,
      onboardingStage: "asked_name",
      now: Date.now(),
    });
  }

  private async captureNameAndSendSpotifyLink(
    space: Space,
    user: Doc<"users">,
    text: string,
  ) {
    const name = await this.ai.extractName(text).catch(() => text.trim().split(/\s+/)[0] ?? "you");
    const updated = await convex.mutation(api.users.setName, {
      userId: user._id,
      preferredName: name,
      now: Date.now(),
    });
    await this.sendSpotifyLink(space, updated ?? user, name);
  }

  private async sendSpotifyLink(space: Space, user: Doc<"users">, name?: string) {
    const link = await this.spotify.authorizationUrl(user._id);
    const reply = await this.safeReply(
      {
        kind: "link_spotify",
        name: name ?? user.preferredName ?? undefined,
        spotifyUrl: link,
      },
      `${name ? `sick, ${name}. ` : ""}link spotify and i'll make your first playlist: ${link}`,
    );
    await sendLogged(space, user._id, reply);
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
    },
  ) {
    const requestId = await convex.mutation(api.conversation.createRequest, {
      userId: user._id,
      prompt: args.prompt,
      intent: args.intent ?? args.requestKind,
      now: Date.now(),
    });

    try {
      const context = await this.freshMusicContext(user._id);
      const plan = await this.ai.playlistPlan({
        prompt: args.prompt,
        context,
        defaultCount: args.defaultCount,
        pollAnswer: args.pollAnswer,
      });

      if (plan.needsPoll && plan.pollQuestion && plan.pollOptions?.length && !args.pollAnswer) {
        await convex.mutation(api.conversation.createPendingPoll, {
          userId: user._id,
          originalPrompt: args.prompt,
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

      const knownTrackIds = new Set(context.tracks.map((track) => track.spotifyTrackId));
      const candidates = await this.spotify.searchTracks(
        user._id,
        plan.searchQueries,
        knownTrackIds,
      );
      const familiarTracks = this.familiarTracks(context.tracks, plan.familiarTrackIds);
      const selected = await this.selectTracks(args.prompt, plan, candidates, familiarTracks);

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
          spotifyUrl: playlist.url,
          extra: plan.userFacingSummary,
        },
        `made ${playlist.name}: ${playlist.url}`,
      );
      await sendLogged(space, user._id, reply);

      if (args.requestKind === "user") {
        await this.maybeSendPaywall(space, user);
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

  private async freshMusicContext(userId: Id<"users">) {
    let context = await convex.query(api.spotify.getMusicContext, { userId });
    if (!hasFreshSync(context.user, context)) {
      await this.spotify.syncUserLibrary(userId);
      context = await convex.query(api.spotify.getMusicContext, { userId });
    }

    if (context.user && (!context.user.tasteSummary || !context.user.activityPreferencesJson)) {
      const summary = await this.ai.summarizeTaste(context);
      await convex.mutation(api.users.updateTasteSummary, {
        userId,
        tasteSummary: summary.tasteSummary,
        activityPreferencesJson: summary.activityPreferences
          ? JSON.stringify(summary.activityPreferences)
          : undefined,
        now: Date.now(),
      });
      context = await convex.query(api.spotify.getMusicContext, { userId });
    }

    return context;
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
      .slice(0, 60);
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
  ) {
    const chosen = await this.ai.chooseTracks({
      prompt,
      plan,
      candidates,
      familiarTracks,
    });
    const byId = new Map<string, RotationTrack>();
    for (const track of [...candidates, ...familiarTracks]) {
      byId.set(track.spotifyTrackId, track);
    }

    const selected = chosen.selectedTrackIds
      .map((id) => byId.get(id))
      .filter((track): track is RotationTrack => Boolean(track));

    const filled = uniqueById([
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
