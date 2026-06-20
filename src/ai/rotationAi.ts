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

const model = () => google(env.geminiModel);

const styleGuide = [
  "you are rotation, a music concierge that texts like a sharp friend.",
  "always write in lowercase.",
  "match the user's energy and wording without being cringe.",
  "use an occasional emoji only when it helps.",
  "keep messages short. never explain internals.",
  "do not mention ai, models, prompts, or tool calls.",
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
  shortReason: z.string().max(120),
});

const playlistPlanSchema = z.object({
  needsPoll: z.boolean(),
  pollQuestion: z.string().max(120).optional(),
  pollOptions: z.array(z.string().max(40)).min(2).max(4).optional(),
  playlistName: z.string().min(1).max(80),
  playlistDescription: z.string().min(1).max(240),
  targetCount: z.number().int().min(15).max(200),
  searchQueries: z.array(z.string().min(2).max(120)).min(4).max(40),
  familiarTrackIds: z.array(z.string()).max(25),
  vibe: z.string().max(160),
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
    | "popularity"
    | "playlistIds"
  >,
) => ({
  id: track.spotifyTrackId,
  name: track.name,
  artists: track.artists.slice(0, 3),
  album: track.album,
  source: track.source,
  popularity: track.popularity,
  playlistIds: track.playlistIds,
});

const contextForModel = (context: MusicContext) => {
  const savedTracks = context.tracks.filter((track) => track.source === "saved");
  const otherTracks = context.tracks.filter((track) => track.source !== "saved");

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
      otherTrackCount: otherTracks.length,
      playlistCount: context.playlists.length,
    },
    playlists: context.playlists.slice(0, 300).map((playlist) => ({
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
    savedTracks: savedTracks.map(compactTrack),
    otherTracks: otherTracks.slice(0, 2_800).map(compactTrack),
  };
};

const preserveUrlsLowercase = (text: string) => {
  const urls: string[] = [];
  const placeholderText = text.replace(/https?:\/\/\S+/g, (url) => {
    urls.push(url);
    return `__url_${urls.length - 1}__`;
  });
  return placeholderText
    .toLowerCase()
    .replace(/__url_(\d+)__/g, (_, index: string) => urls[Number(index)] ?? "");
};

export class RotationAi {
  async classify(message: string) {
    const result = await generateObject({
      model: model(),
      schema: intentSchema,
      system: styleGuide,
      prompt: `classify this inbound text for a spotify playlist texting bot:\n\n${message}`,
    });
    return result.object;
  }

  async extractName(message: string) {
    const result = await generateObject({
      model: model(),
      schema: firstNameSchema,
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
  }) {
    const result = await generateObject({
      model: model(),
      schema: playlistPlanSchema,
      system: `${styleGuide}

you choose music by using the user's spotify library context and spotify catalog search.
the savedTracks array is the user's liked songs. for new music, treat every saved track as important taste evidence and as a strict exclusion list.
think deeply about patterns across the liked songs: recurring artists, microgenres, production texture, era, mood, tempo, vocal style, scenes, and adjacent songs similar in nature.
return search queries that spotify search can actually answer, like artist names, genre words, song/artist combinations, or scene descriptors.
if the request is under-specified and there are two meaningfully different directions, ask a short multiple choice poll.
otherwise make a confident call.
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
          noveltyMode: args.newOnly ? "new_music_only" : "balanced",
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
  }) {
    const result = await generateObject({
      model: model(),
      schema: selectedTracksSchema,
      system: `${styleGuide}

choose the best spotify tracks for the requested playlist.
if novelty mode is new_music_only, return only candidate track ids. use familiar tracks only as taste references, never as playlist picks.
for new music/discovery, prioritize tracks that fit the user's taste but are less obvious: adjacent artists, deeper cuts, and non-super-mainstream songs. avoid huge hits unless explicitly requested.
if novelty mode is balanced, prefer candidate tracks for discovery, but include familiar tracks when they strongly fit.
avoid duplicate artists too close together unless the prompt asks for one artist.
return only ids from the provided lists that are allowed by the novelty mode.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          plan: args.plan,
          noveltyMode: args.newOnly ? "new_music_only" : "balanced",
          targetCount: args.plan.targetCount,
          candidates: args.candidates.slice(0, 260).map(compactTrack),
          familiarTracks: args.familiarTracks.slice(0, 80).map(compactTrack),
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
      | "poll_repeat"
      | "smalltalk"
      | "error";
    userText?: string;
    name?: string;
    spotifyUrl?: string;
    playlistName?: string;
    extra?: string;
  }) {
    const result = await generateText({
      model: model(),
      system: styleGuide,
      prompt: JSON.stringify(args),
    });
    return preserveUrlsLowercase(result.text.trim());
  }
}
