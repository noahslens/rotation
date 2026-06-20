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
  reason: z.string().max(180),
});

const tasteSummarySchema = z.object({
  tasteSummary: z.string().min(20).max(900),
  activityPreferences: z.record(z.string(), z.string()).optional(),
});

const firstNameSchema = z.object({
  name: z.string().min(1).max(40),
});

const compactTrack = (track: Pick<RotationTrack, "spotifyTrackId" | "name" | "artists" | "album" | "source" | "popularity">) => ({
  id: track.spotifyTrackId,
  name: track.name,
  artists: track.artists.slice(0, 3),
  album: track.album,
  source: track.source,
  popularity: track.popularity,
});

const contextForModel = (context: MusicContext) => ({
  user: {
    name: context.user?.preferredName ?? context.user?.displayName,
    spotifyName: context.user?.spotifyDisplayName,
    tasteSummary: context.user?.tasteSummary,
    activityPreferencesJson: context.user?.activityPreferencesJson,
  },
  playlists: context.playlists.slice(0, 45).map((playlist) => ({
    id: playlist.spotifyPlaylistId,
    name: playlist.name,
    description: playlist.description,
    trackCount: playlist.trackCount,
  })),
  tracks: context.tracks.slice(0, 260).map(compactTrack),
});

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
  }) {
    const result = await generateObject({
      model: model(),
      schema: playlistPlanSchema,
      system: `${styleGuide}

you choose music by using the user's spotify library context and spotify catalog search.
return search queries that spotify search can actually answer, like artist names, genre words, song/artist combinations, or scene descriptors.
if the request is under-specified and there are two meaningfully different directions, ask a short multiple choice poll.
otherwise make a confident call.
for discovery, lean toward songs not already in the user's library.
for activity playlists, blend familiar anchors with new songs that fit the moment.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          pollAnswer: args.pollAnswer,
          defaultTargetCount: args.defaultCount,
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
  }) {
    const result = await generateObject({
      model: model(),
      schema: selectedTracksSchema,
      system: `${styleGuide}

choose the best spotify tracks for the requested playlist.
prefer candidate tracks for new discovery, but include familiar tracks when they strongly fit.
avoid duplicate artists too close together unless the prompt asks for one artist.
return only ids from the provided candidate or familiar lists.`,
      prompt: JSON.stringify(
        {
          userPrompt: args.prompt,
          plan: args.plan,
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
