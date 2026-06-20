import { google } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { Doc } from "../../convex/_generated/dataModel";
import { env } from "../config/env";
import type { CandidateTrack, RotationTrack } from "../services/spotify";

type MusicContext = {
  user: Doc<"users"> | null;
  playlists: Doc<"spotifyPlaylists">[];
  tracks: Doc<"spotifyTracks">[];
};

export type ConversationTurn = {
  direction: "in" | "out";
  text: string;
  createdAt: number;
  messageId?: string;
};

const model = () => google(env.geminiModel);
const coverModel = () => google(env.geminiCoverModel);
const providerOptions = {
  google: {
    thinkingConfig: {
      thinkingLevel: "medium" as const,
      includeThoughts: false,
    },
  },
};

const styleGuide = [
  "you are rotation, a music concierge that texts like a sharp friend.",
  "always write in lowercase.",
  "match the user's energy and wording without being cringe.",
  "use an occasional emoji only when it helps.",
  "keep messages short. never explain internals.",
  "do not mention ai, models, prompts, or tool calls.",
  "rotation cannot render markdown. write plain text only. do not use markdown formatting, markdown links, headings, bullets, numbered lists, bold, or italics.",
  "do not overuse the word vibe. use more specific words like mood, pace, setting, energy, texture, scene, or sound when they fit.",
  "prefer natural contractions in user-facing messages, like it's over it is, you're over you are, i'll over i will, and don't over do not.",
  "never use em dashes.",
].join("\n");

const playlistJudgmentRules = [
  "before choosing music, interpret the situation: private listening vs group setting, activity, life moment, location, time of day, desired familiarity, energy arc, and how much the room needs obvious shared context.",
  "for social, party, school, graduation, birthday, wedding, pregame, trip, pool, beach, barbecue, or group settings, the event and room can outrank the user's normal taste, especially for the first 5 to 10 songs.",
  "include culturally obvious anchors, era staples, event staples, and crowd layups when they fit the situation, even if they are not usually the user's exact taste, unless the user explicitly asks for obscure, deep cuts, or new music only.",
  "choose the opener deliberately. track 1 should be the most situation-perfect tone setter, not merely the strongest personal taste match. in a group setting it should feel immediate, recognizable, and playable.",
  "if the user explicitly names a first track, opener, or start-with song, put that exact recording first once. do not include alternate versions, covers, remixes, or repeated versions of that song unless the user explicitly asks for multiple versions.",
  "avoid repeated versions of the same song title in one playlist.",
  "for culturally obvious requests, include exact song and artist search queries for must-consider anchors so spotify can return them. for example, a high school graduation pool party should consider the spins mac miller plus sunny graduation, pool, senior summer, and party staples.",
  "after the essential situation anchors are covered, use the user's taste to shape texture, adjacent picks, sequencing, and deeper cuts.",
].join("\n");

const conversationRules = [
  "recentConversation is chronological message history from about the last hour, if available.",
  "use recentConversation to resolve follow-ups, pronouns, corrections, poll context, prior playlist requests, user preferences stated in chat, and references like that, same vibe, more upbeat, or less mainstream.",
  "the latest inbound user message is still the main instruction. do not let old conversation override a clear new request.",
  "do not silently merge an older mood/activity/location into a new standalone playlist request. if the latest message could reasonably mean either a fresh playlist or a continuation of the previous playlist idea, ask a short multiple choice poll instead of assuming.",
  "only carry previous playlist attributes forward when the user uses explicit follow-up language like same, that, this, more like, keep, still, again, make it, or from before.",
  "do not quote or summarize recentConversation unless the user asks.",
].join("\n");

const deliveryFacts = [
  "when rotation creates a spotify playlist, the user can also find it at the top of their spotify library.",
  "if a playlist link or preview does not show up, the user can ask rotation to resend it.",
].join("\n");

const playlistNamingRules = [
  "playlist names should be about 20 percent less corny than your first instinct.",
  "prefer simple, understated, natural names, usually 1 to 4 words.",
  "stay close to the user's wording when it is already good, like happy, pool party, morning run, or lock in.",
  "avoid puns, therapy-speak, main-character language, hype-beast phrasing, and names like sunny disposition, serotonin, golden hour glow, immaculate vibes, or anything with an emoji.",
  "descriptions and user-facing summaries should also be casual and specific, not overwritten.",
].join("\n");

const intentSchema = z.object({
  intent: z.enum([
    "help",
    "billing",
    "discovery",
    "activity_playlist",
    "more_like_playlist",
    "more_like_artist",
    "taste_expansion",
    "smalltalk",
  ]),
  confidence: z.number().min(0).max(1),
  shortReason: z.string().max(500),
  auxiliaryReaction: z.string().max(24).nullable().optional(),
});

const playlistPlanSchema = z.object({
  needsPoll: z.boolean(),
  pollQuestion: z.string().max(120).optional(),
  pollOptions: z.array(z.string().max(40)).min(2).max(4).optional(),
  playlistName: z.string().min(1).max(80),
  playlistDescription: z.string().min(1).max(240),
  targetCount: z.number().int().min(8).max(200),
  searchQueries: z.array(z.string().min(2).max(120)).min(4).max(40),
  familiarTrackIds: z.array(z.string()).max(200),
  vibe: z.string().max(160),
  userFacingSummary: z.string().min(1).max(320),
});

const playlistEditPlanSchema = z.object({
  action: z.enum(["add_tracks", "remove_tracks", "replace_tracks", "mixed_update", "rename"]),
  needsPoll: z.boolean(),
  pollQuestion: z.string().max(120).optional(),
  pollOptions: z.array(z.string().max(40)).min(2).max(4).optional(),
  playlistName: z.string().min(1).max(80).nullable().optional(),
  playlistDescription: z.string().min(1).max(240).nullable().optional(),
  targetCount: z.number().int().min(0).max(200),
  searchQueries: z.array(z.string().min(2).max(120)).max(40),
  keepTrackIds: z.array(z.string()).max(200),
  removeTrackIds: z.array(z.string()).max(200),
  userFacingSummary: z.string().min(1).max(320),
});

const selectedTracksSchema = z.object({
  selectedTrackIds: z.array(z.string()).min(1).max(200),
  reason: z.string().max(1000),
});

const tasteSummarySchema = z.object({
  tasteSummary: z.string().min(20).max(900),
  activityPreferences: z.record(z.string(), z.string()).optional(),
});

const textingActionSchema = z.object({
  mode: z.enum(["reaction_only", "message_only", "both", "none"]),
  reaction: z.string().max(24).nullable().optional(),
  message: z.string().max(320).nullable().optional(),
});

const coverSelectionSchema = z.object({
  selectedPhotoId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(240),
});

const voiceActionSchema = z.object({
  intent: z.enum([
    "help",
    "billing",
    "discovery",
    "activity_playlist",
    "more_like_playlist",
    "more_like_artist",
    "taste_expansion",
    "smalltalk",
  ]),
  confidence: z.number().min(0).max(1),
  promptText: z.string().max(2000),
  message: z.string().max(320).nullable().optional(),
  auxiliaryReaction: z.string().max(24).nullable().optional(),
  wantsSpotifyLink: z.boolean().optional(),
  playlistPlan: playlistPlanSchema.nullable().optional(),
});

const firstNameSchema = z.object({
  name: z.string().min(1).max(40),
});

const compactTrack = (
  track: Pick<
    RotationTrack,
    | "spotifyTrackId"
    | "name"
    | "artists"
    | "album"
    | "source"
    | "sources"
    | "popularity"
    | "playlistIds"
    | "playlistCount"
    | "tasteWeight"
  >,
) => ({
  id: track.spotifyTrackId,
  name: track.name,
  artists: track.artists.slice(0, 3),
  album: track.album,
  source: track.source,
  sources: track.sources,
  popularity: track.popularity,
  playlistIds: track.playlistIds,
  playlistCount: track.playlistCount,
  tasteWeight: track.tasteWeight,
});

const contextForModel = (context: MusicContext) => {
  const hasSource = (track: RotationTrack, source: RotationTrack["source"]) =>
    track.source === source || Boolean(track.sources?.includes(source));
  const byWeight = (left: RotationTrack, right: RotationTrack) =>
    (right.tasteWeight ?? 0) - (left.tasteWeight ?? 0);
  const savedTracks = context.tracks.filter((track) => hasSource(track, "saved"));
  const topTracks = context.tracks.filter((track) => hasSource(track, "top"));
  const playlistTracks = context.tracks.filter((track) => hasSource(track, "playlist"));
  const createdTracks = context.tracks.filter((track) => hasSource(track, "created"));

  return {
    user: {
      name: context.user?.preferredName ?? context.user?.displayName,
      spotifyName: context.user?.spotifyDisplayName,
      spotifyUserId: context.user?.spotifyUserId,
      tasteSummary: context.user?.tasteSummary,
      activityPreferencesJson: context.user?.activityPreferencesJson,
    },
    stats: {
      savedTrackCount: savedTracks.length,
      topTrackCount: topTracks.length,
      playlistTrackCount: playlistTracks.length,
      createdTrackCount: createdTracks.length,
      totalTrackCount: context.tracks.length,
      playlistCount: context.playlists.length,
    },
    playlists: context.playlists.map((playlist) => ({
      id: playlist.spotifyPlaylistId,
      name: playlist.name,
      description: playlist.description,
      ownerId: playlist.ownerId,
      ownerName: playlist.ownerName,
      isUserOwned: Boolean(
        context.user?.spotifyUserId && playlist.ownerId === context.user.spotifyUserId,
      ),
      trackCount: playlist.trackCount,
    })),
    savedTracks: savedTracks.sort(byWeight).map(compactTrack),
    topTracks: topTracks.sort(byWeight).map(compactTrack),
    playlistTracks: playlistTracks.sort(byWeight).map(compactTrack),
    createdTracks: createdTracks.sort(byWeight).map(compactTrack),
  };
};

const conversationForModel = (turns?: ConversationTurn[]) =>
  (turns ?? []).slice(-60).map((turn) => ({
    role: turn.direction === "in" ? "user" : "rotation",
    text: turn.text.slice(0, 700),
    minutesAgo: Math.max(0, Math.round((Date.now() - turn.createdAt) / 60_000)),
  }));

const preserveUrlsLowercase = (text: string) => {
  const urls: string[] = [];
  const placeholderText = text.replace(/https?:\/\/\S+/g, (url) => {
    urls.push(url);
    return `__url_${urls.length - 1}__`;
  });
  return placeholderText
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/__url_(\d+)__/g, (_, index: string) => urls[Number(index)] ?? "");
};

export class RotationAi {
  async classify(args: {
    message: string;
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateObject({
      model: model(),
      schema: intentSchema,
      providerOptions,
      system: `${styleGuide}

${conversationRules}
${deliveryFacts}`,
      prompt: `classify this inbound text for a spotify playlist texting bot.

also choose an optional auxiliary reaction for the user's message when it adds texture while rotation works.
for playlist-making requests, include a relevant auxiliaryReaction almost always because rotation should react while generating. examples: 🏃 for a run request, 🏋️ for gym, 🔒 for lock-in/focus, 🔥 for hype, 🎧 for discovery, ❤️ for a genuinely nice message.
leave auxiliaryReaction empty for routine commands, unclear requests, billing, or anything where a reaction would feel extra.

${JSON.stringify(
  {
    text: args.message,
    recentConversation: conversationForModel(args.conversationHistory),
  },
  null,
  2,
)}`,
    });
    return result.object;
  }

  async extractName(message: string) {
    const result = await generateObject({
      model: model(),
      schema: firstNameSchema,
      providerOptions,
      system: styleGuide,
      prompt: `extract the user's preferred first name from this reply. if they gave multiple words, choose the name they would expect us to use.\n\nreply: ${message}`,
    });
    return result.object.name.trim();
  }

  async playlistPlan(args: {
    prompt: string;
    context: MusicContext;
    defaultCount: number;
    pollAnswer?: string;
    newOnly?: boolean;
    fixedTargetCount?: boolean;
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateObject({
      model: model(),
      schema: playlistPlanSchema,
      providerOptions,
      system: `${styleGuide}

you choose music by using the user's full stored spotify song history plus spotify catalog search.
the musicContext contains full stored song history by source: liked songs in savedTracks, listening-history proxy tracks in topTracks, user-owned playlist tracks in playlistTracks, and prior rotation outputs in createdTracks.
each track can include sources, playlistCount, and tasteWeight. tasteWeight is computed in convex from liked status, spotify top-track presence, and number of user-owned playlists containing the track.
${playlistJudgmentRules}
${conversationRules}
${playlistNamingRules}
the savedTracks array is the user's liked songs. for new music, treat every saved track as important taste evidence and as a strict exclusion list.
do not average all history into one generic taste. filter the full history against the current request first, then use only the songs, artists, moods, scenes, tempos, and textures that fit.
ignore songs from the user's history that do not fit the requested mood/activity/context, even if they are strong taste signals generally.
for balanced/activity playlists, you may pull directly from the user's history when those songs fit the moment, or use the fitting songs as seeds to find adjacent new music.
think deeply about patterns across the liked songs: recurring artists, microgenres, production texture, era, mood, tempo, vocal style, scenes, and adjacent songs similar in nature.
return search queries that spotify search can actually answer, like artist names, genre words, song/artist combinations, or scene descriptors.
if the request is under-specified and there are two meaningfully different directions, ask a short multiple choice poll.
if recentConversation creates ambiguity, use needsPoll with options that separate the fresh interpretation from the carried-over interpretation, like london only vs sad london.
pollAnswer overrides ambiguous prior context. if the user picks a fresh interpretation, ignore the older playlist mood/activity unless it still independently fits.
otherwise make a confident call.
silently decide the right playlist length. do not show reasoning.
if countMode is fixed, set targetCount exactly to defaultTargetCount.
if countMode is dynamic, set targetCount based on the user's prompt, explicit count, explicit time window, and activity.
for dynamic counts: obey explicit requested song counts when present; if the user specifies a duration, estimate about 3 minutes per song; for quick walks/showers/short drives use 12-25 songs; for runs/gym/focus sessions use 35-80; for parties/road trips/deep discovery use 80-200.
if countMode is dynamic and the prompt does not imply duration or scale, choose the smallest playlist that feels complete for the task instead of defaulting to 50.
for new music/discovery, use saved songs, top tracks, and weighted playlist tracks as taste evidence only. the playlist itself must be music outside their known library.
for new music/discovery, find layups they are likely to fall in love with: very close in taste, but not already liked and not obvious top hits they have probably heard.
for new music/discovery, avoid super mainstream picks unless the user explicitly asks for mainstream, hits, or familiar music.
for new music/discovery, search for adjacent artists, deeper cuts, scene/genre descriptors, label/era sounds, and artist combinations that strongly fit their taste.
playlist owner/name matters: user-owned and personally named playlists are stronger taste evidence than spotify/editorial/charts/radio playlists.
for activity playlists, blend familiar anchors with new songs that fit the moment.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          pollAnswer: args.pollAnswer,
          defaultTargetCount: args.defaultCount,
          countMode: args.fixedTargetCount ? "fixed" : "dynamic",
          noveltyMode: args.newOnly ? "new_music_only" : "balanced",
          recentConversation: conversationForModel(args.conversationHistory),
          musicContext: contextForModel(args.context),
        },
        null,
        2,
      ),
    });

    return result.object;
  }

  async chooseTracks(args: {
    prompt: string;
    plan: z.infer<typeof playlistPlanSchema>;
    candidates: CandidateTrack[];
    familiarTracks: RotationTrack[];
    newOnly?: boolean;
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateObject({
      model: model(),
      schema: selectedTracksSchema,
      providerOptions,
      system: `${styleGuide}

choose the best spotify tracks for the requested playlist.
${playlistJudgmentRules}
${conversationRules}
selectedTrackIds is ordered playlist sequencing. the first id becomes track 1 in spotify.
filter against the user's prompt first: a song that is in their history but wrong for the mood/activity should be ignored.
if novelty mode is new_music_only, return only candidate track ids. use familiar tracks only as taste references, never as playlist picks.
for new music/discovery, prioritize tracks that fit the user's taste but are less obvious: adjacent artists, deeper cuts, and non-super-mainstream songs. avoid huge hits unless explicitly requested.
if novelty mode is balanced, prefer candidate tracks for discovery, but include familiar tracks from the user's history when they strongly fit the request.
for balanced group/social playlists, include the strongest situation anchors before taste-only picks, and sequence the opener as the most context-perfect song available.
avoid duplicate artists too close together unless the prompt asks for one artist.
return only ids from the provided lists that are allowed by the novelty mode.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          plan: args.plan,
          noveltyMode: args.newOnly ? "new_music_only" : "balanced",
          targetCount: args.plan.targetCount,
          recentConversation: conversationForModel(args.conversationHistory),
          candidates: args.candidates.slice(0, 320).map(compactTrack),
          familiarTracks: args.familiarTracks.map(compactTrack),
        },
        null,
        2,
      ),
    });
    return result.object;
  }

  async summarizeTaste(context: MusicContext) {
    const result = await generateObject({
      model: model(),
      schema: tasteSummarySchema,
      providerOptions,
      system: styleGuide,
      prompt: `summarize this user's music taste and infer activity preferences from playlist names. be concrete and compact.\n\n${JSON.stringify(contextForModel(context), null, 2)}`,
    });
    return result.object;
  }

  async shortReply(args: {
    kind:
      | "greeting"
      | "link_spotify"
      | "linked"
      | "playlist_ready"
      | "help"
      | "not_linked"
      | "pre_spotify_question"
      | "poll_repeat"
      | "smalltalk"
      | "error";
    userText?: string;
    name?: string;
    spotifyUrl?: string;
    playlistName?: string;
    extra?: string;
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateText({
      model: model(),
      providerOptions,
      system: `${styleGuide}

${conversationRules}
${deliveryFacts}`,
      prompt: JSON.stringify({
        ...args,
        conversationHistory: undefined,
        recentConversation: conversationForModel(args.conversationHistory),
      }),
    });
    return preserveUrlsLowercase(result.text.trim());
  }

  async textingAction(args: {
    kind: "smalltalk" | "pre_spotify_question" | "help";
    userText: string;
    fallbackMessage?: string;
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateObject({
      model: model(),
      schema: textingActionSchema,
      providerOptions,
      system: `${styleGuide}

choose how rotation should respond in imessage.
${conversationRules}
${deliveryFacts}
you can send just a tapback/reaction, just a text message, both, or nothing.
use reaction_only for thanks, compliments, agreement, laughter, or low-information nice messages that do not require a real reply.
use message_only for questions, instructions, or anything needing content, with no reaction.
use both when a quick reaction plus a short useful reply feels natural.
reaction can be a single emoji or a tapback word like love, like, laugh, emphasize, question.
when including a reaction and a message, do not put the same emoji in the message.
messages must be lowercase, compact, natural, and plain text only.
when kind is pre_spotify_question, these are the only facts you should rely on:
- rotation makes spotify playlists over text.
- spotify must be connected before playlist creation or personalized recommendations.
- before spotify is connected, answer lightweight product/setup questions.
- if they ask whether apple music, soundcloud, youtube music, yt music, or another non-spotify service is supported, say not yet, spotify is the only one live rn, we're rushing to add the others asap, and we'll text them when it's ready.
- do not include an auth link or say a link is attached unless the user explicitly asks for one.
- if they want to connect, tell them to ask for a fresh link.
- only mention price if the user specifically asks about price, cost, paid plans, billing, or subscriptions.
- if asked about price, say rotation is $29.99/y after the first request.`,
      prompt: JSON.stringify(
        {
          ...args,
          conversationHistory: undefined,
          recentConversation: conversationForModel(args.conversationHistory),
        },
        null,
        2,
      ),
    });
    return {
      ...result.object,
      message: result.object.message
        ? preserveUrlsLowercase(result.object.message.trim())
        : result.object.message,
    };
  }

  async playlistEditPlan(args: {
    prompt: string;
    context: MusicContext;
    targetPlaylist: {
      id: string;
      name: string;
      description?: string;
      trackCount: number;
    };
    currentTracks: RotationTrack[];
    conversationHistory?: ConversationTurn[];
  }) {
    const result = await generateObject({
      model: model(),
      schema: playlistEditPlanSchema,
      providerOptions,
      system: `${styleGuide}

you edit an existing spotify playlist. do not create a new playlist.
${playlistJudgmentRules}
${conversationRules}
${playlistNamingRules}
choose the smallest useful edit that satisfies the user.
if they ask to add songs or make it longer, use action add_tracks and targetCount is the number of tracks to add. obey explicit counts; otherwise add 8-20 tracks. adding does not require removing anything.
if they ask to remove songs, use action remove_tracks and list current track ids to remove.
if they ask to remove some songs and add others in the same request, use action mixed_update. list removeTrackIds and search queries for what to add. targetCount is the number of tracks to add.
if they ask to make it more/less like a vibe or ask for a final playlist length, replace weak tracks while preserving existing tracks that still fit. use action replace_tracks and targetCount is the final playlist length.
if they ask only to rename or change description, use action rename.
use currentTracks ids exactly for keepTrackIds and removeTrackIds.
do not remove repeated versions of the same song just because titles match. only remove duplicates if the user asks to dedupe or remove repeats.
if the edit request is ambiguous enough that you cannot safely act, ask a short poll.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          targetPlaylist: args.targetPlaylist,
          currentTracks: args.currentTracks.slice(0, 220).map(compactTrack),
          recentConversation: conversationForModel(args.conversationHistory),
          musicContext: contextForModel(args.context),
        },
        null,
        2,
      ),
    });
    return result.object;
  }

  async preSpotifyReply(
    userText: string,
    conversationHistory?: ConversationTurn[],
  ) {
    const result = await generateText({
      model: model(),
      providerOptions,
      system: `${styleGuide}

${conversationRules}`,
      prompt: `answer this text from someone who has not connected spotify yet.

facts:
- rotation makes spotify playlists over text.
- after spotify is connected, rotation can read their liked songs, playlists, and listening context to make better playlists.
- it can make activity/mood playlists, find new music, make more like an artist/playlist, or help rediscover old favorites.
- spotify must be connected before rotation can make playlists or personalize recommendations.
- if they ask whether apple music, soundcloud, youtube music, yt music, or another non-spotify service is supported, say not yet, spotify is the only one live rn, we're rushing to add the others asap, and we'll text them when it's ready.
- only mention price if they ask about price, cost, paid plans, billing, or subscriptions.
- if asked about price, say rotation is $29.99/y after their first request.
- do not include an auth link or tell them a link is attached.
- if they want to connect, tell them to ask for a fresh link when they're ready.

${JSON.stringify(
  {
    userText,
    recentConversation: conversationForModel(conversationHistory),
  },
  null,
  2,
)}`,
    });
    return preserveUrlsLowercase(result.text.trim());
  }

  async voiceAction(args: {
    voices: Array<{
      bytes: Buffer;
      mimeType: string;
      name?: string;
      duration?: number;
    }>;
    context?: MusicContext;
    defaultCount: number;
    fixedTargetCount?: boolean;
    newOnly?: boolean;
    preSpotify?: boolean;
    conversationHistory?: ConversationTurn[];
  }) {
    const audioParts = args.voices.flatMap((voice, index) => [
      {
        type: "text" as const,
        text: `voice note ${index + 1}: name=${voice.name ?? "voice note"}, mimeType=${voice.mimeType}, duration=${voice.duration ?? "unknown"} seconds`,
      },
      {
        type: "file" as const,
        data: voice.bytes,
        filename: voice.name ?? `voice-note-${index + 1}`,
        mediaType: voice.mimeType,
      },
    ]);

    const result = await generateObject({
      model: model(),
      schema: voiceActionSchema,
      providerOptions,
      system: `${styleGuide}

listen to the raw audio voice note and decide how rotation should handle it.
this replaces the normal text classify + playlist-planning prompt for voice notes.
if the user asks for a playlist, return playlistPlan directly from the audio and music context.
for playlist requests, set auxiliaryReaction to a relevant emoji so rotation can react while generating.
if the user asks billing/help/smalltalk, return the short message to send.
promptText is a compact text label for logging, billing, spotify search, and playlist metadata. it should preserve the user's request, not be a full transcript.
wantsSpotifyLink is true only when the user explicitly asks to connect or get a fresh spotify link.
if spotify is not connected, do not create a playlistPlan. answer product/setup questions briefly and tell them to ask for a fresh link only if they want to connect.
if spotify is not connected and they ask whether apple music, soundcloud, youtube music, yt music, or another non-spotify service is supported, say not yet, spotify is the only one live rn, we're rushing to add the others asap, and we'll text them when it's ready.
if spotify is connected, use the full music context the same way playlistPlan uses it for typed prompts.
${playlistJudgmentRules}
${conversationRules}
${playlistNamingRules}
for playlistPlan rules, follow the same rules as typed playlist planning: dynamic counts for user requests, fixed counts only when countMode is fixed, new-music requests should exclude known liked/saved songs, and activity playlists may blend familiar anchors with fitting discovery.`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  spotifyConnected: !args.preSpotify,
                  defaultTargetCount: args.defaultCount,
                  countMode: args.fixedTargetCount ? "fixed" : "dynamic",
                  noveltyMode:
                    args.newOnly === undefined
                      ? "decide_from_audio"
                      : args.newOnly
                        ? "new_music_only"
                        : "balanced",
                  recentConversation: conversationForModel(args.conversationHistory),
                  musicContext: args.context
                    ? contextForModel(args.context)
                    : undefined,
                },
                null,
                2,
              ),
            },
            ...audioParts,
          ],
        },
      ],
    });

    return {
      ...result.object,
      promptText: preserveUrlsLowercase(result.object.promptText.trim()),
      message: result.object.message
        ? preserveUrlsLowercase(result.object.message.trim())
        : result.object.message,
    };
  }

  async chooseCoverPhoto(args: {
    userPrompt: string;
    playlistName: string;
    playlistDescription: string;
    vibe: string;
    userFacingSummary: string;
    photos: Array<{
      id: string;
      name: string;
      uploadedAt: number;
      mimeType: string;
      bytes: Buffer;
    }>;
  }) {
    if (args.photos.length === 0) {
      return { selectedPhotoId: null, confidence: 0, reason: "no photos" };
    }

    const content = [
      {
        type: "text" as const,
        text: `pick the single saved user photo that best fits this spotify playlist cover.

playlist:
name: ${args.playlistName}
description: ${args.playlistDescription}
vibe: ${args.vibe}
request: ${args.userPrompt}
summary: ${args.userFacingSummary}

rules:
- prefer selecting a saved photo when one plausibly fits the playlist mood, activity, scene, or energy.
- broad moods count: for happy, upbeat, summer, party, chill, sad, focus, or romantic playlists, choose the photo whose visual feeling best matches the mood.
- prefer personal-feeling photos over generic ones when both fit.
- for happy/upbeat playlists, bright, colorful, sunny, smiling, social, water, travel, outdoor, or playful photos are good fits.
- return selectedPhotoId as null only when every photo would feel actively wrong or distracting as the cover.
- respond only through the schema.

photos are provided below, each preceded by its id.`,
      },
      ...args.photos.flatMap((photo, index) => [
        {
          type: "text" as const,
          text: `photo ${index + 1}: id=${photo.id}, name=${photo.name}, uploadedAt=${photo.uploadedAt}`,
        },
        {
          type: "image" as const,
          image: photo.bytes,
          mediaType: "image/jpeg",
        },
      ]),
    ];

    const result = await generateObject({
      model: coverModel(),
      schema: coverSelectionSchema,
      providerOptions,
      system: styleGuide,
      messages: [{ role: "user", content }],
    });
    return result.object;
  }
}
