import type { Message, Space, SpectrumInstance } from "spectrum-ts";
import {
  attachment,
  contact,
  poll,
  richlink,
  type ContentInput,
} from "spectrum-ts";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  RotationAi,
  type ConversationTurn,
  type PlaylistAiProvider,
} from "../ai/rotationAi";
import { env } from "../config/env";
import { api, convex } from "../state/convex";
import {
  billingPortalText,
  paymentLinkForUser,
  paywallText,
} from "../services/stripe";
import {
  type CoverPhotoCandidate,
  fetchPhotoBytes,
  isImageMime,
  listUnusedUserPhotos,
  markPhotoUsed,
  modelPhotoJpeg,
  saveUserPhoto,
  spotifyCoverJpeg,
} from "../services/photos";
import {
  type CandidateTrack,
  type EditablePlaylist,
  type RotationTrack,
  SpotifyService,
} from "../services/spotify";

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;
const weekMs = 7 * dayMs;
const recentConversationMs = 60 * 60 * 1000;
const recentConversationLimit = 80;
const readySoonProgressMs = 200 * 1000;
const initialRetryCooldownMs = 60 * 60 * 1000;

type MusicContext = Awaited<ReturnType<typeof convex.query<typeof api.spotify.getMusicContext>>>;
type TextingAction = {
  mode?: "reaction_only" | "message_only" | "both" | "none";
  reaction?: string | null;
  message?: string | null;
};
type PlaylistPlan = Awaited<ReturnType<RotationAi["playlistPlan"]>>;
type PlaylistVariantResult = {
  provider: PlaylistAiProvider;
  label: string;
  plan: PlaylistPlan;
  selected: RotationTrack[];
  playlist: {
    id: string;
    name: string;
    url: string;
  };
};

const fallbackCopy = {
  greeting:
    "yo, i'm rotation. i'll make your spotify playlists over text, helping you find new music and rediscover old favs. i get better as i learn your taste over time.",
  linked:
    "spotify is linked. i'm digesting your taste now and making your first rotation. this takes about 2-5 mins.",
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

const textFromMessage = (message: Message) => {
  if (isTextMessage(message)) return message.content.text;
  const content = message.content as {
    type: string;
    markdown?: unknown;
    text?: unknown;
    url?: unknown;
  };
  if (content.type === "markdown" && typeof content.markdown === "string") {
    return content.markdown;
  }
  if (content.type === "richlink" && typeof content.url === "string") {
    return content.url;
  }
  if (typeof content.text === "string" && content.text.trim()) return content.text;
  return undefined;
};

const messageContentSummary = (message: Message) => {
  const content = message.content as {
    type: string;
    items?: unknown;
    mimeType?: unknown;
    name?: unknown;
    size?: unknown;
    url?: unknown;
  };
  return {
    type: content.type,
    itemCount: Array.isArray(content.items) ? content.items.length : undefined,
    mimeType: typeof content.mimeType === "string" ? content.mimeType : undefined,
    name: typeof content.name === "string" ? content.name : undefined,
    size: typeof content.size === "number" ? content.size : undefined,
    hasUrl: typeof content.url === "string",
  };
};

type ReactionMessage = Message & {
  content: { type: "reaction"; emoji: string; target: Message };
};

const isReactionMessage = (message: Message): message is ReactionMessage =>
  message.content.type === "reaction";

type AttachmentContent = {
  type: "attachment";
  id?: string;
  name?: string;
  mimeType: string;
  size?: number;
  read?: () => Promise<Buffer>;
};

type VoiceContent = {
  type: "voice";
  name?: string;
  mimeType: string;
  duration?: number;
  size?: number;
  read: () => Promise<Buffer>;
};

type PhotoAttachment = {
  messageId?: string;
  name: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
};

type VoiceNote = {
  messageId?: string;
  name?: string;
  mimeType: string;
  duration?: number;
  size?: number;
  read: () => Promise<Buffer>;
};

type AttachmentFetcher = {
  getAttachment: (id: string, phone?: string) => Promise<AttachmentContent | undefined>;
};

const isAudioMime = (mimeType: string | undefined) =>
  Boolean(mimeType?.toLowerCase().startsWith("audio/"));

const phoneFromSpace = (space: Space) => {
  const phone = (space as { phone?: unknown }).phone;
  return typeof phone === "string" ? phone : undefined;
};

const attachmentRead = (
  content: AttachmentContent,
  space: Space,
  attachmentFetcher?: AttachmentFetcher,
) => async () => {
  if (typeof content.read === "function") return await content.read();
  if (!content.id || !attachmentFetcher) {
    throw new Error("attachment bytes unavailable");
  }

  const fetched = await attachmentFetcher.getAttachment(content.id, phoneFromSpace(space));
  if (!fetched?.read) {
    throw new Error("attachment bytes unavailable");
  }
  return await fetched.read();
};

const photoAttachmentsFromMessage = (
  message: Message,
  space: Space,
  attachmentFetcher?: AttachmentFetcher,
): PhotoAttachment[] => {
  const content = message.content;
  if (content.type === "attachment" && isImageMime(content.mimeType)) {
    const attachment = content as AttachmentContent;
    return [
      {
        messageId: message.id,
        name: attachment.name ?? "photo",
        mimeType: attachment.mimeType,
        size: attachment.size,
        read: attachmentRead(attachment, space, attachmentFetcher),
      },
    ];
  }

  if (content.type === "group") {
    return content.items.flatMap((item) =>
      photoAttachmentsFromMessage(item, space, attachmentFetcher),
    );
  }

  return [];
};

export const voiceNotesFromMessage = (
  message: Message,
  space: Space,
  attachmentFetcher?: AttachmentFetcher,
): VoiceNote[] => {
  const content = message.content;
  if (content.type === "voice") {
    const voice = content as VoiceContent;
    return [
      {
        messageId: message.id,
        name: voice.name,
        mimeType: voice.mimeType,
        duration: voice.duration,
        size: voice.size,
        read: voice.read,
      },
    ];
  }

  if (content.type === "attachment" && isAudioMime(content.mimeType)) {
    const audio = content as AttachmentContent;
    return [
      {
        messageId: message.id,
        name: audio.name ?? "voice-note",
        mimeType: audio.mimeType,
        size: audio.size,
        read: attachmentRead(audio, space, attachmentFetcher),
      },
    ];
  }

  if (content.type === "group") {
    return content.items.flatMap((item) =>
      voiceNotesFromMessage(item, space, attachmentFetcher),
    );
  }

  return [];
};

const tapbacks = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
} as const;

const reactionAliases: Record<string, string> = {
  love: tapbacks.love,
  heart: tapbacks.love,
  hearts: tapbacks.love,
  red_heart: tapbacks.love,
  redheart: tapbacks.love,
  thanks: tapbacks.love,
  thank_you: tapbacks.love,
  like: tapbacks.like,
  thumbs_up: tapbacks.like,
  thumbsup: tapbacks.like,
  yes: tapbacks.like,
  agree: tapbacks.like,
  dislike: tapbacks.dislike,
  thumbs_down: tapbacks.dislike,
  thumbsdown: tapbacks.dislike,
  no: tapbacks.dislike,
  laugh: tapbacks.laugh,
  lol: tapbacks.laugh,
  lmao: tapbacks.laugh,
  haha: tapbacks.laugh,
  emphasize: tapbacks.emphasize,
  exclaim: tapbacks.emphasize,
  bangbang: tapbacks.emphasize,
  "!!": tapbacks.emphasize,
  question: tapbacks.question,
  "?": tapbacks.question,
  running: "🏃",
  run: "🏃",
  jog: "🏃",
  gym: "🏋️",
  lift: "🏋️",
  workout: "🏋️",
  focus: "🔒",
  lock_in: "🔒",
  lockin: "🔒",
  coding: "💻",
  code: "💻",
  fire: "🔥",
  hype: "🔥",
  music: "🎧",
  headphones: "🎧",
  sparkles: "✨",
};

const emojiOnlyPattern = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+$/u;

const preserveUrlsLowercase = (text: string) => {
  const urls: string[] = [];
  const placeholderText = text.replace(/https?:\/\/\S+/g, (url) => {
    urls.push(url);
    return `__url_${urls.length - 1}__`;
  });
  return placeholderText
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/__url_(\d+)__/g, (_, index: string) => urls[Number(index)] ?? "");
};

const removeDuplicateReactionEmoji = (message: string | undefined, reaction?: string) => {
  if (!message || !reaction || !emojiOnlyPattern.test(reaction)) return message;
  const stripped = message
    .split(reaction)
    .join("")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || undefined;
};

const removeInlineUrls = (message: string) =>
  message
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const removePlaylistDeliveryHints = (message: string) => {
  const cleaned = message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const clean = sentence.toLowerCase();
      return !(
        /\b(check|look|find|waiting|wait|refresh|pull down)\b.{0,40}\b(library|spotify|second|ready)\b/.test(
          clean,
        ) ||
        /\b(top of (your )?(spotify )?library|in a second|link is attached|preview)\b/.test(
          clean,
        )
      );
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || message;
};

const removePlaylistCounts = (message: string) =>
  message
    .replace(
      /\b\d+\s+(?=(?:fresh|new|deep|off-grid|near-certain|handpicked|songs|tracks|cuts)\b)/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

export const normalizeReaction = (reaction?: string | null) => {
  if (!reaction) return undefined;
  const trimmed = reaction.trim();
  if (!trimmed) return undefined;
  const directTapback = Object.values(tapbacks).find((tapback) => tapback === trimmed);
  if (directTapback) return directTapback;

  const alias = trimmed
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replace(/[\s-]+/g, "_");
  if (reactionAliases[alias]) return reactionAliases[alias];
  if (trimmed.length <= 12 && emojiOnlyPattern.test(trimmed)) return trimmed;
  return undefined;
};

export const formatTextingAction = (
  action: TextingAction,
  fallbackMessage?: string,
): { reaction?: string; message?: string } => {
  const reaction =
    action.mode === "reaction_only" || action.mode === "both"
      ? normalizeReaction(action.reaction)
      : undefined;
  const rawMessage =
    action.mode === "reaction_only" || action.mode === "none"
      ? undefined
      : action.message?.trim() || fallbackMessage;
  const message = removeDuplicateReactionEmoji(
    rawMessage ? preserveUrlsLowercase(rawMessage) : undefined,
    reaction,
  );
  return { reaction, message };
};

export const formatPlaylistReadyReply = (
  reply: string,
  fallback: string,
  avoidReaction?: string | null,
) => {
  const withoutUrls = removeInlineUrls(reply) || fallback;
  const withoutDeliveryHints = removePlaylistDeliveryHints(withoutUrls);
  const withoutCounts = removePlaylistCounts(withoutDeliveryHints);
  const withoutDuplicateReaction = removeDuplicateReactionEmoji(
    withoutCounts,
    normalizeReaction(avoidReaction),
  );
  return withoutDuplicateReaction || fallback;
};

const fallbackDelayedProgress =
  "there's a specific lane here. digging for songs that feel like they should already be in your likes.";
const readySoonProgressMessage = "still working. it'll be ready soon.";
const playlistProviders = (): PlaylistAiProvider[] =>
  env.openRouterApiKey || env.anthropicApiKey ? ["gemini", "sonnet"] : ["gemini"];
const playlistProviderLabel = (provider: PlaylistAiProvider) =>
  provider === "sonnet" ? "sonnet" : "gemini";
const ordinalLabel = (index: number) =>
  index === 0 ? "first" : index === 1 ? "second" : `option ${index + 1}`;
const compactPollName = (name: string) => {
  const clean = preserveUrlsLowercase(name).replace(/[^\p{L}\p{N}\s'&]/gu, "");
  return clean.length > 22 ? clean.slice(0, 21).trim() : clean;
};

export const playlistVoteOptions = (playlistNames: string[]) =>
  playlistNames.map((name, index) => {
    const label = ordinalLabel(index);
    const compact = compactPollName(name) || `playlist ${index + 1}`;
    return `${label}: ${compact}`.slice(0, 40);
  });

export const formatDelayedProgressMessage = (message?: string) => {
  const base = preserveUrlsLowercase(message?.trim() || fallbackDelayedProgress);
  if (/\balmost done\b/i.test(base)) return base;
  return `${base.replace(/[.!?]*$/, ".")} almost done.`;
};

export const formatReadySoonProgressMessage = (message?: string) => {
  const base = preserveUrlsLowercase(message?.trim() || readySoonProgressMessage);
  if (/\bready soon\b/i.test(base)) return base;
  return `${base.replace(/[.!?]*$/, ".")} it'll be ready soon.`;
};

export const photoUploadAck = (args: {
  existingPhotoCount: number;
  incomingCount: number;
  savedCount: number;
  failureCount: number;
}): { reaction?: string; message?: string } => {
  if (args.failureCount > 0) {
    if (args.savedCount > 0) {
      const picLabel = args.savedCount === 1 ? "pic" : "pics";
      return {
        message: `saved ${args.savedCount} ${picLabel}. ${args.failureCount} didn't come through.`,
      };
    }
    return {
      message:
        args.incomingCount === 1
          ? "couldn't save that one. try sending it again in a sec."
          : "couldn't save those. try sending them again in a sec.",
    };
  }

  if (args.savedCount === 1) {
    if (args.existingPhotoCount === 0) return { message: "saved it." };
    return { reaction: "✅" };
  }

  if (args.savedCount > 1) return { message: `saved ${args.savedCount} pics` };
  return { message: "couldn't save those. try sending them again in a sec." };
};

export const tapbackFeedbackReply = (emoji: string) => {
  switch (emoji) {
    case tapbacks.dislike:
      return "noted - tell me what missed and i'll tune the next one.";
    case tapbacks.question:
      return "what should i clarify?";
    default:
      return undefined;
  }
};

const tapbackLogText = (message: ReactionMessage) => {
  const target = message.content.target.content;
  const targetSummary =
    target.type === "text" ? target.text.slice(0, 160) : target.type;
  return `tapback ${message.content.emoji} on ${targetSummary}`;
};

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

export const playlistLinkContent = (url: string) => richlink(url);

export const stripePaymentLinkContent = (userId: string) => {
  const link = paymentLinkForUser(userId);
  return link ? richlink(link) : undefined;
};

const compactError = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught);

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export const spotifyPlaylistIdFromText = (text: string) => {
  const match =
    text.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/i) ??
    text.match(/spotify:playlist:([A-Za-z0-9]+)/i);
  return match?.[1];
};

const quotedPlaylistName = (text: string) => {
  const match =
    text.match(/["“”']([^"“”']{2,80})["“”']/) ??
    text.match(/\b(?:playlist|called|named)\s+([a-z0-9][a-z0-9\s'.&-]{1,80})/i);
  return match?.[1]?.trim();
};

export const playlistEditIntent = (text: string) => {
  const clean = normalize(text);
  if (!clean) return false;
  const makePlaylistEdit = /\bmake (it|that|this|the playlist|this playlist|that playlist)\b/.test(
    clean,
  );
  const mutatingVerb =
    /\b(tweak|edit|change|adjust|update|rename|add|remove|delete|replace|swap|move|reorder|shorten|extend)\b/.test(
      clean,
    );
  const moreTracksEdit =
    /\b(?:\d+\s+)?more\s+(songs?|tracks?|cuts?)\b/.test(clean) ||
    /\b(?:add|throw|toss|put)\b.{0,24}\b(?:\d+\s+)?(?:more\s+)?(songs?|tracks?|cuts?)\b/.test(
      clean,
    );
  const moreLikeRequest =
    /\b(more|songs|stuff|music|playlist)\b.{0,32}\blike\b/.test(clean) ||
    /\blike\b.{0,48}\b(this|that|it|playlist|link|one)\b/.test(clean);
  if (moreLikeRequest && !mutatingVerb && !makePlaylistEdit) {
    return false;
  }
  if (spotifyPlaylistIdFromText(text)) return true;

  const editVerb =
    mutatingVerb ||
    moreTracksEdit ||
    /\b(make shorter|make longer)\b/.test(clean) ||
    /\bmake (it|that|this|the playlist|this playlist|that playlist)\b.{0,24}\b(more|less)\b/.test(
      clean,
    );
  if (!editVerb) return false;

  if (moreTracksEdit) return true;

  const directPlaylistRef =
    /\b(playlist|mix|rotation)\b/.test(clean) ||
    /\b(it|that|this|that one|this one|the one|same one)\b/.test(clean);
  const makeIt = /\bmake (it|that|this|the playlist)\b/.test(clean);
  return directPlaylistRef || makeIt;
};

export const playlistAutoDeleteRequest = (
  text: string,
  now = Date.now(),
): { durationMs: number; deleteAt: number; label: string } | null => {
  const clean = text
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  if (/\b(don't|dont|do not|never|cancel|stop)\b/.test(clean)) return null;

  const directDuration = clean.match(
    /^(?:(?:in|after)\s+)?(\d{1,4})\s*(h|hr|hrs|hour|hours|d|day|days|w|week|weeks)(?:\s*(?:please|pls))?$/,
  );
  const deleteIntent =
    /\b(auto\s?delete|delete|expire|expires|expiration|remove)\b/.test(clean);
  if (!directDuration && !deleteIntent) return null;

  const match =
    directDuration ??
    clean.match(/\b(\d{1,4})\s*(h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/);
  if (!match) return null;

  const rawAmount = match[1];
  const unit = match[2];
  if (!rawAmount || !unit) return null;

  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const durationMs = unit.startsWith("h")
    ? amount * hourMs
    : unit.startsWith("w")
      ? amount * weekMs
      : amount * dayMs;
  if (durationMs < hourMs || durationMs > 365 * dayMs) return null;

  const labelUnit = unit.startsWith("h")
    ? amount === 1
      ? "hour"
      : "hours"
    : unit.startsWith("w")
      ? amount === 1
        ? "week"
        : "weeks"
      : amount === 1
        ? "day"
        : "days";

  return {
    durationMs,
    deleteAt: now + durationMs,
    label: `${amount} ${labelUnit}`,
  };
};

const playlistWorkIntents = new Set([
  "discovery",
  "activity_playlist",
  "more_like_playlist",
  "more_like_artist",
  "taste_expansion",
]);

const carryoverAmbiguityMs = 15 * 60 * 1000;
const explicitFollowupPattern =
  /\b(same|that|this|those|previous|last|earlier|again|still|keep|continue|more like|from before|make it|make that|make this|with|but|also)\b/;
const moodCarryoverPattern =
  /\b(sad|happy|chill|dark|rainy|late night|night|sleepy|angry|hype|romantic|melancholy|melancholic|nostalgic|summer|winter|fall|spring|sunny|moody|depressing|upbeat|calm|cozy)\b/;
const activityDescriptorPattern =
  /\b(run|running|gym|lift|lifting|workout|coding|code|study|studying|focus|party|pregame|drive|driving|road trip|sleep|shower|walk|walking|date|dinner)\b/;

const playlistDescriptor = (value: string) =>
  normalize(value)
    .replace(
      /\b(make|create|give|send|build|me|my|a|an|the|some|new|songs|music|playlist|mix|rotation|for|to|please|pls)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

export const carryoverAmbiguityPoll = (
  text: string,
  conversationHistory: ConversationTurn[],
  intent?: string,
  now = Date.now(),
): { question: string; options: string[] } | null => {
  if (intent && !playlistWorkIntents.has(intent)) return null;
  const clean = normalize(text);
  if (!clean || explicitFollowupPattern.test(clean)) return null;

  const currentDescriptor = playlistDescriptor(text);
  const currentWords = currentDescriptor.split(/\s+/).filter(Boolean);
  if (
    currentWords.length === 0 ||
    currentWords.length > 3 ||
    moodCarryoverPattern.test(currentDescriptor) ||
    activityDescriptorPattern.test(currentDescriptor)
  ) {
    return null;
  }

  const previous = [...conversationHistory]
    .reverse()
    .find((turn) => {
      if (turn.direction !== "in") return false;
      if (now - turn.createdAt > carryoverAmbiguityMs) return false;
      const priorClean = normalize(turn.text);
      if (!priorClean || priorClean === clean) return false;
      const priorDescriptor = playlistDescriptor(turn.text);
      return (
        priorDescriptor &&
        moodCarryoverPattern.test(priorDescriptor) &&
        !currentDescriptor.includes(priorDescriptor)
      );
    });
  if (!previous) return null;

  const previousDescriptor = playlistDescriptor(previous.text);
  const combined = `${previousDescriptor} ${currentDescriptor}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  const freshOption = `${currentDescriptor} only`.slice(0, 40);
  return {
    question: `for ${currentDescriptor}, should i keep ${previousDescriptor} from earlier?`,
    options: [freshOption, combined],
  };
};

export const playlistWorkingReaction = (
  text: string,
  intent?: string,
  modelReaction?: string | null,
) => {
  const normalizedModelReaction = normalizeReaction(modelReaction);
  if (normalizedModelReaction) return normalizedModelReaction;
  if (intent && !playlistWorkIntents.has(intent)) return undefined;

  const clean = normalize(text);
  if (/\b(run|running|jog|jogging|sprint|marathon)\b/.test(clean)) return "🏃";
  if (/\b(gym|lift|lifting|workout|work out|leg day|push day|pull day)\b/.test(clean)) {
    return "🏋️";
  }
  if (/\b(lock in|lockin|focus|study|studying|code|coding|repo|essay|write|writing)\b/.test(clean)) {
    return "🔒";
  }
  if (/\b(hype|pregame|party|rager|turn up|turnup|pool|graduation|birthday)\b/.test(clean)) {
    return "🔥";
  }
  if (/\b(rain|rainy|storm|stormy)\b/.test(clean)) return "🌧️";
  if (/\b(night|late night|sleep|midnight)\b/.test(clean)) return "🌙";
  if (/\b(happy|sunny|summer|beach|morning)\b/.test(clean)) return "☀️";
  if (/\b(car|drive|driving|road trip|roadtrip)\b/.test(clean)) return "🚗";
  if (/\b(date|girl|mood|romantic)\b/.test(clean)) return "🖤";
  if (/\b(new|discover|discovery|more like|songs i'd fw|songs id fw)\b/.test(clean)) {
    return "🎧";
  }
  return "🎧";
};

export const directPlaylistRequest = (text: string):
  | {
      intent:
        | "discovery"
        | "activity_playlist"
        | "more_like_playlist"
        | "more_like_artist"
        | "taste_expansion";
      confidence: number;
      shortReason: string;
      auxiliaryReaction?: string | null;
    }
  | null => {
  const clean = normalize(text);
  if (!clean) return null;
  if (
    /\b(price|cost|billing|subscription|subscribe|cancel|portal|refund)\b/.test(clean)
  ) {
    return null;
  }

  const discovery =
    /\b(more stuff id fw|songs id fw|put me on|new songs|fresh songs|discover|discovery)\b/.test(
      clean,
    ) || /\bmore stuff\b.{0,12}\bfw\b/.test(clean);
  if (discovery) {
    return {
      intent: "discovery",
      confidence: 0.95,
      shortReason: "explicit discovery playlist request",
      auxiliaryReaction: playlistWorkingReaction(text, "discovery"),
    };
  }

  const creationVerb =
    /\b(make|create|build|give|send|queue|cook|generate|need|want)\b/.test(clean);
  const playlistNoun = /\b(playlist|mix|rotation)\b/.test(clean);
  if (creationVerb && playlistNoun) {
    return {
      intent: "activity_playlist",
      confidence: 0.95,
      shortReason: "explicit playlist creation request",
      auxiliaryReaction: playlistWorkingReaction(text, "activity_playlist"),
    };
  }

  return null;
};

export const explicitOpenerQuery = (prompt: string) => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const match =
    compact.match(/\b(?:first|1st)\s+(?:track|song)\s*(?:is|:|-)?\s+(.+)$/i) ??
    compact.match(/\b(?:start|open|lead off)\s+(?:with|w\/)\s+(.+)$/i);
  const query = match?.[1]
    ?.replace(/\b(?:then|and then|after that)\b.*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  return query ? query.slice(0, 120) : undefined;
};

const openerScore = (track: RotationTrack, query: string) => {
  const normalizedQuery = normalize(query);
  const name = normalize(track.name);
  if (!normalizedQuery || !name) return 0;

  let score = normalizedQuery.includes(name) ? 80 : 0;
  const artistText = normalize(track.artists.join(" "));
  for (const artist of track.artists) {
    const normalizedArtist = normalize(artist);
    if (normalizedArtist && normalizedQuery.includes(normalizedArtist)) {
      score += 35;
      break;
    }
  }
  if (artistText && normalizedQuery.includes(artistText)) score += 15;
  return score + (track.popularity ?? 0) / 100;
};

const findExplicitOpener = (tracks: RotationTrack[], query: string) => {
  const [best] = tracks
    .map((track) => ({ track, score: openerScore(track, query) }))
    .filter(({ score }) => score >= 80)
    .sort((left, right) => right.score - left.score);
  return best?.track;
};

export const finalizeSelectedTracks = (
  selected: RotationTrack[],
  pool: RotationTrack[],
  openerQuery?: string,
) => {
  if (!openerQuery) return selected;
  const opener = findExplicitOpener(pool, openerQuery);
  if (!opener) return selected;
  return [
    opener,
    ...selected.filter((track) => track.spotifyTrackId !== opener.spotifyTrackId),
  ];
};

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
  `${greetingPrefix(text)}, i'm rotation. i'll make your spotify playlists over text, helping you find new music and rediscover old favs. i get better as i learn your taste over time.`;

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
      (!user.spotifyLinked || Boolean(user.spotifyUserId)) &&
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

const normalizedLibraryText = (value: string | undefined) =>
  normalize(value ?? "")
    .replace(
      /\b(remaster(?:ed)?|radio edit|single version|album version|explicit|clean|sped up|slowed|instrumental|live|mono|stereo|bonus track|deluxe|edit|version)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

export const libraryTrackKey = (
  track: Pick<RotationTrack, "name" | "artists">,
) => {
  const title = normalizedLibraryText(track.name);
  const primaryArtist = normalizedLibraryText(track.artists[0]);
  return title && primaryArtist ? `${primaryArtist}::${title}` : undefined;
};

export const filterKnownLibraryTracks = <T extends RotationTrack>(
  tracks: T[],
  libraryTracks: Array<Pick<RotationTrack, "spotifyTrackId" | "name" | "artists">>,
) => {
  const knownIds = new Set(libraryTracks.map((track) => track.spotifyTrackId));
  const knownKeys = new Set(
    libraryTracks
      .map((track) => libraryTrackKey(track))
      .filter((key): key is string => Boolean(key)),
  );

  return tracks.filter((track) => {
    if (knownIds.has(track.spotifyTrackId)) return false;
    const key = libraryTrackKey(track);
    return !key || !knownKeys.has(key);
  });
};

const allowsRepeatedSongVersions = (prompt: string) =>
  /\b(every|all|multiple|different)\b.{0,24}\b(versions?|recordings?|covers?|remixes?|takes?)\b/i.test(
    prompt,
  ) ||
  /\b(versions?|recordings?|covers?|remixes?|takes?)\b.{0,24}\b(every|all|multiple|different)\b/i.test(
    prompt,
  );

export const uniquePlaylistTracks = <T extends RotationTrack>(
  tracks: T[],
  options: { allowSameArtistTitleRepeats?: boolean } = {},
) => {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  return tracks.filter((track) => {
    if (seenIds.has(track.spotifyTrackId)) return false;
    const key = libraryTrackKey(track);
    if (!options.allowSameArtistTitleRepeats && key && seenKeys.has(key)) {
      return false;
    }
    seenIds.add(track.spotifyTrackId);
    if (key) seenKeys.add(key);
    return true;
  });
};

export const enforcePlaylistDiversity = <T extends RotationTrack>(
  tracks: T[],
  limits: { maxPerAlbum?: number; maxPerArtist?: number },
) => {
  const albumCounts = new Map<string, number>();
  const artistCounts = new Map<string, number>();
  return tracks.filter((track) => {
    const primaryArtist = normalizedLibraryText(track.artists[0]);
    const album = normalizedLibraryText(track.album);
    const albumKey = primaryArtist && album ? `${primaryArtist}::${album}` : undefined;
    if (
      limits.maxPerArtist !== undefined &&
      primaryArtist &&
      (artistCounts.get(primaryArtist) ?? 0) >= limits.maxPerArtist
    ) {
      return false;
    }
    if (
      limits.maxPerAlbum !== undefined &&
      albumKey &&
      (albumCounts.get(albumKey) ?? 0) >= limits.maxPerAlbum
    ) {
      return false;
    }
    if (primaryArtist) {
      artistCounts.set(primaryArtist, (artistCounts.get(primaryArtist) ?? 0) + 1);
    }
    if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
    return true;
  });
};

const filterTracksAlreadyPresentBySong = <T extends RotationTrack>(
  tracks: T[],
  existingTracks: Array<Pick<RotationTrack, "spotifyTrackId" | "name" | "artists">>,
) => {
  const existingIds = new Set(existingTracks.map((track) => track.spotifyTrackId));
  const existingKeys = new Set(
    existingTracks
      .map((track) => libraryTrackKey(track))
      .filter((key): key is string => Boolean(key)),
  );
  return tracks.filter((track) => {
    if (existingIds.has(track.spotifyTrackId)) return false;
    const key = libraryTrackKey(track);
    return !key || !existingKeys.has(key);
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

export const wantsPlaylistLinkResend = (text: string) => {
  const clean = normalize(text);
  if (!clean) return false;

  const resendIntent =
    /\b(resend|re-send|send again|send it again|send that again|send the link again|drop it again|drop the link again|text it again)\b/.test(
      clean,
    ) ||
    /\b(didn'?t|did not|never)\b.{0,24}\b(go through|send|come through|show up|get|got)\b/.test(
      clean,
    ) ||
    /\b(no|missing|lost|broken|failed)\b.{0,16}\b(playlist\s+)?(link|preview)\b/.test(
      clean,
    ) ||
    /\b(link|preview)\b.{0,24}\b(didn'?t|did not|never|failed|broke|missing|lost)\b/.test(
      clean,
    );
  if (!resendIntent) return false;

  const playlistReference =
    /\b(playlist|rotation|spotify playlist|the link|playlist link|preview|rich link|it|that)\b/.test(
      clean,
    );
  const spotifyAuthReference =
    /\b(spotify|auth|login|connect|authorize|reauth|re auth)\b/.test(clean) &&
    !/\bplaylist\b/.test(clean);

  return playlistReference && !spotifyAuthReference;
};

export const unsupportedMusicServiceReply = (text: string) => {
  const clean = normalize(text);
  if (!clean) return undefined;

  const service =
    /\b(apple music|soundcloud|youtube music|yt music|ytmusic|youtube|tidal|amazon music|deezer|pandora|bandcamp)\b/.test(
      clean,
    );
  if (!service) return undefined;

  const supportQuestion =
    /\b(support|work with|connect|link|integrate|integration|available|use|do you do|can you do|can i use|is there|when)\b/.test(
      clean,
    );
  const shortServiceQuestion = clean.length <= 40 && /\?$/.test(text.trim());

  if (!supportQuestion && !shortServiceQuestion) return undefined;

  return "not yet. spotify is the only one live rn, but we're rushing to add apple music, soundcloud, youtube music, and the rest asap. i'll text you when they're ready.";
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

const familiarMixOptions = [
  "25% current",
  "50% current",
  "75% current",
  "100% current",
];

export const familiarMixPercent = (value: string | undefined | null) => {
  const match = value?.match(/\b(25|50|75|100)\s*%?/);
  return match ? Number(match[1]) : undefined;
};

const explicitSongCount = (text: string) => {
  const match = normalize(text).match(/\b(\d{1,3})\s*(?:songs?|tracks?|cuts?)\b/);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isInteger(count) ? count : undefined;
};

const explicitDurationMinutes = (text: string) => {
  const clean = normalize(text);
  const match = clean.match(/\b(\d{1,3})\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes)\b/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount)) return undefined;
  return match[2]?.startsWith("h") ? amount * 60 : amount;
};

export const familiarMixPoll = (
  text: string,
  intent?: string,
): { question: string; options: string[] } | null => {
  if (intent !== "activity_playlist") return null;
  if (asksForNewMusic(text) || explicitlyAllowsKnownMusic(text)) return null;
  if (familiarMixPercent(text) !== undefined) return null;

  const clean = normalize(text);
  const broadActivity =
    /\b(gym|lift|lifting|workout|work out|leg day|push day|pull day|run|running|focus|study|studying|code|coding|repo|essay|work|party|pregame|going out|night out|drive|road trip|pool|beach|graduation|birthday|cleaning|cookout|barbecue|bbq)\b/.test(
      clean,
    );
  const count = explicitSongCount(text);
  const duration = explicitDurationMinutes(text);
  const broadByScale = (count !== undefined && count >= 35) || (duration !== undefined && duration >= 45);
  if ((count !== undefined && count < 35) || (duration !== undefined && duration < 45)) {
    return null;
  }
  if (!broadActivity && !broadByScale) return null;

  return {
    question: "how much should be songs you already know?",
    options: familiarMixOptions,
  };
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

const takeInto = <T extends RotationTrack>(
  result: T[],
  pool: T[],
  count: number,
  options: { allowSameArtistTitleRepeats?: boolean },
) => {
  if (count <= 0) return;
  const existing = uniquePlaylistTracks(result, options);
  result.splice(0, result.length, ...existing);
  for (const track of pool) {
    if (result.length >= count) return;
    const next = uniquePlaylistTracks([...result, track], options);
    if (next.length > result.length) result.push(track);
  }
};

const applyFamiliarMix = (args: {
  selected: RotationTrack[];
  candidates: CandidateTrack[];
  familiarTracks: RotationTrack[];
  targetCount: number;
  familiarPercent?: number;
  allowSameArtistTitleRepeats?: boolean;
}) => {
  const options = {
    allowSameArtistTitleRepeats: args.allowSameArtistTitleRepeats,
  };
  if (args.familiarPercent === undefined) {
    return uniquePlaylistTracks(
      [...args.selected, ...args.candidates, ...args.familiarTracks],
      options,
    ).slice(0, args.targetCount);
  }

  const familiarIds = new Set(
    args.familiarTracks.map((track) => track.spotifyTrackId),
  );
  const selected = uniquePlaylistTracks(args.selected, options);
  const familiarPool = uniquePlaylistTracks(
    [
      ...selected.filter((track) => familiarIds.has(track.spotifyTrackId)),
      ...args.familiarTracks,
    ],
    options,
  );
  const newPool = uniquePlaylistTracks(
    [
      ...selected.filter((track) => !familiarIds.has(track.spotifyTrackId)),
      ...args.candidates,
    ],
    options,
  );
  const familiarTarget =
    args.familiarPercent >= 100
      ? args.targetCount
      : Math.min(
          familiarPool.length,
          Math.round(args.targetCount * (args.familiarPercent / 100)),
        );
  const newTarget =
    args.familiarPercent >= 100
      ? 0
      : Math.min(newPool.length, args.targetCount - familiarTarget);

  const result: RotationTrack[] = [];
  takeInto(result, familiarPool, familiarTarget, options);
  takeInto(result, newPool, familiarTarget + newTarget, options);
  takeInto(result, familiarPool, args.targetCount, options);
  if (args.familiarPercent < 100) {
    takeInto(result, newPool, args.targetCount, options);
  }
  return uniquePlaylistTracks(result, options).slice(0, args.targetCount);
};

const hasActiveSubscription = (user: Pick<Doc<"users">, "subscriptionStatus">) =>
  user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing";

export class RotationBot {
  constructor(
    private readonly ai: RotationAi,
    private readonly spotify: SpotifyService,
    private readonly attachmentFetcher?: AttachmentFetcher,
  ) {}

  async handle(space: Space, message: Message) {
    if (message.direction === "outbound") return;
    const platformUserId = message.sender?.id;
    console.info("[rotation.inbound_seen]", {
      platform: message.platform,
      spaceId: space.id,
      sender: platformUserId,
      messageId: message.id,
      content: messageContentSummary(message),
      partIndex: (message as { partIndex?: unknown }).partIndex,
      parentId: (message as { parentId?: unknown }).parentId,
    });
    if (isReactionMessage(message)) {
      await this.handleTapback(space, message);
      return;
    }
    const voiceNotes = voiceNotesFromMessage(message, space, this.attachmentFetcher);
    if (voiceNotes.length) {
      await this.handleVoiceNote(space, message, voiceNotes);
      return;
    }
    const photoAttachments = photoAttachmentsFromMessage(
      message,
      space,
      this.attachmentFetcher,
    );
    if (photoAttachments.length) {
      await this.handlePhotoUpload(space, message, photoAttachments);
      return;
    }
    const inboundText = textFromMessage(message);
    if (!inboundText) {
      await this.handleUnsupportedInbound(space, message);
      return;
    }

    if (!platformUserId) return;

    console.info("[rotation.inbound]", {
      platform: message.platform,
      spaceId: space.id,
      sender: platformUserId,
      messageId: message.id,
      text: inboundText,
    });

    const now = Date.now();
    const user = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!user) return;

    const claim = await convex.mutation(api.conversation.claimInboundMessage, {
      userId: user._id,
      text: inboundText,
      messageId: message.id,
      now,
    });
    if (!claim.claimed) {
      console.info("[rotation.duplicate_inbound_skipped]", {
        userId: user._id,
        messageId: message.id,
      });
      return;
    }

    try {
      await message.read().catch((caught) => {
        console.warn("[rotation.read_failed]", compactError(caught));
      });
      const conversationHistory = await this.recentConversation(user._id);
      await this.route(space, user, inboundText, message, conversationHistory);
    } catch (caught) {
      await this.recordFailure("message_handler", user._id, { text: inboundText }, caught);
      console.error("[rotation.error]", caught);
      await sendLogged(space, user._id, fallbackCopy.error).catch((sendError) => {
        console.error("[rotation.fallback_send_failed]", sendError);
      });
    }
  }

  private async handleUnsupportedInbound(space: Space, message: Message) {
    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

    const now = Date.now();
    const user = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!user) return;

    const summary = messageContentSummary(message);
    const claim = await convex.mutation(api.conversation.claimInboundMessage, {
      userId: user._id,
      text: `unsupported inbound: ${summary.type}`,
      messageId: message.id,
      now,
    });
    if (!claim.claimed) return;

    await message.read().catch((caught) => {
      console.warn("[rotation.unsupported_read_failed]", compactError(caught));
    });
    console.warn("[rotation.unsupported_inbound]", {
      userId: user._id,
      messageId: message.id,
      content: summary,
    });
  }

  private async handleTapback(space: Space, message: ReactionMessage) {
    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

    const now = Date.now();
    const user = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!user) return;

    const claim = await convex.mutation(api.conversation.claimInboundMessage, {
      userId: user._id,
      text: tapbackLogText(message),
      messageId: message.id,
      now,
    });
    if (!claim.claimed) return;

    await message.read().catch((caught) => {
      console.warn("[rotation.tapback_read_failed]", compactError(caught));
    });

    const reply = tapbackFeedbackReply(message.content.emoji);
    if (reply) await sendLogged(space, user._id, reply);
  }

  private async handleVoiceNote(
    space: Space,
    message: Message,
    voiceNotes: VoiceNote[],
  ) {
    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

    const now = Date.now();
    const existingVoiceUser = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!existingVoiceUser) return;
    let user: Doc<"users"> = existingVoiceUser;
    const claim = await convex.mutation(api.conversation.claimInboundMessage, {
      userId: user._id,
      text: "voice note: audio",
      messageId: message.id,
      now,
    });
    if (!claim.claimed) {
      console.info("[rotation.duplicate_inbound_skipped]", {
        userId: user._id,
        messageId: message.id,
      });
      return;
    }
    const inboundTurnId = claim.turnId;

    try {
      await message.read().catch((caught) => {
        console.warn("[rotation.voice_read_failed]", compactError(caught));
      });

      const voices = await this.withTyping(space, async () => {
        const items: Array<{
          bytes: Buffer;
          mimeType: string;
          name?: string;
          duration?: number;
        }> = [];
        for (const voice of voiceNotes) {
          const bytes = await voice.read();
          items.push({
            bytes,
            mimeType: voice.mimeType,
            name: voice.name,
            duration: voice.duration,
          });
        }
        return items;
      });
      const conversationHistory = await this.recentConversation(user._id);

      if (user.onboardingStage === "new") {
        const action = await this.ai.voiceAction({
          voices,
          defaultCount: 50,
          preSpotify: true,
          conversationHistory,
        });
        await this.logVoiceTurn(user._id, message.id, now, action.promptText, inboundTurnId);
        await this.withTyping(space, async () => {
          await this.sendGreeting(space, user, action.promptText || "hi");
        });
        return;
      }

      if (!user.spotifyLinked) {
        const action = await this.ai.voiceAction({
          voices,
          defaultCount: 50,
          preSpotify: true,
          conversationHistory,
        });
        await this.logVoiceTurn(user._id, message.id, now, action.promptText, inboundTurnId);

        if (action.wantsSpotifyLink) {
          await this.withTyping(space, async () => {
            await this.sendSpotifyLink(space, user);
          });
          return;
        }

        await this.withTyping(space, async () => {
          await sendLogged(
            space,
            user._id,
            action.message ||
              "i can answer questions here, but i need spotify connected before i can make playlists. ask for a fresh link when you're ready.",
          );
        });
        return;
      }

      if (!user.initialPlaylistDeliveredAt) {
        await this.withTyping(space, async () => {
          await this.deliverInitialPlaylist(space, user);
        });
        const latest = await convex.query(api.users.getById, { userId: user._id });
        if (!latest) return;
        user = latest;
      }

      const context = await this.freshMusicContext(user);
      const action = await this.ai.voiceAction({
        voices,
        context,
        defaultCount: 50,
        conversationHistory,
      });
      const promptText = action.promptText || "voice note";
      await this.logVoiceTurn(user._id, message.id, now, promptText, inboundTurnId);

      if (action.intent === "help") {
        await this.withTyping(space, async () => {
          await sendLogged(space, user._id, action.message || fallbackCopy.help);
        });
        return;
      }

      if (action.intent === "billing") {
        await this.withTyping(space, async () => {
          if (user.stripeCustomerId || hasActiveSubscription(user)) {
            await sendLogged(space, user._id, await billingPortalText(user));
          } else {
            await this.sendPaywall(space, user);
          }
        });
        return;
      }

      if (action.intent === "smalltalk" && action.confidence > 0.78) {
        await this.applyTextingAction(
          space,
          user,
          message,
          {
            mode: action.message ? "both" : "reaction_only",
            reaction: action.auxiliaryReaction,
            message:
              action.message ||
              "i'm here. send me a mood, activity, or artist and i'll make the playlist.",
          },
          {
            fallbackMessage:
              "i'm here. send me a mood, activity, or artist and i'll make the playlist.",
          },
        );
        return;
      }

      const workingReaction = playlistWorkingReaction(
        promptText,
        action.intent,
        action.auxiliaryReaction,
      );
      await this.tapback(message, workingReaction, user._id);

      const shouldGateForPayment =
        Boolean(user.initialPlaylistDeliveredAt) && !hasActiveSubscription(user);
      if (shouldGateForPayment) {
        await this.withTyping(space, async () => {
          await this.sendPaywall(space, user, { buildingPlaylist: true });
        });
        await convex.mutation(api.users.markPaywallShown, {
          userId: user._id,
          now: Date.now(),
        });
      }

      const playlistPlan = action.playlistPlan;
      if (!playlistPlan) {
        throw new Error("voice action did not return a playlist plan");
      }

      await this.withTyping(space, async () => {
        await this.createPlaylistFromPrompt(space, user, {
          prompt: promptText,
          defaultCount: 50,
          requestKind: "user",
          intent: action.intent,
          deferDeliveryUntilPaid: shouldGateForPayment,
          precomputedPlan: playlistPlan,
          precomputedContext: context,
          conversationHistory,
          avoidReaction: workingReaction,
        });
      });
    } catch (caught) {
      await this.recordFailure(
        "voice_note",
        user._id,
        { messageId: message.id, count: voiceNotes.length },
        caught,
      );
      console.error("[rotation.voice_note_failed]", caught);
      await sendLogged(
        space,
        user._id,
        "couldn't hear that one. try sending it again?",
      );
    }
  }

  private async logVoiceTurn(
    userId: Id<"users">,
    messageId: string | undefined,
    now: number,
    promptText: string | undefined,
    turnId?: Id<"conversationTurns">,
  ) {
    const text = `voice note: ${promptText || "audio"}`;
    if (turnId) {
      await convex.mutation(api.conversation.updateTurnText, {
        turnId,
        text,
      });
      return;
    }
    await convex.mutation(api.conversation.logTurn, {
      userId,
      direction: "in",
      text,
      messageId,
      now,
    });
  }

  private async handlePhotoUpload(
    space: Space,
    message: Message,
    photoAttachments: PhotoAttachment[],
  ) {
    const platformUserId = message.sender?.id;
    if (!platformUserId) return;

    const now = Date.now();
    const user = await convex.mutation(api.users.upsertFromMessage, {
      platform: message.platform,
      platformUserId,
      now,
    });
    if (!user) return;

    const names = photoAttachments.map((photo) => photo.name).join(", ");
    const claim = await convex.mutation(api.conversation.claimInboundMessage, {
      userId: user._id,
      text: `uploaded ${photoAttachments.length} photo${photoAttachments.length === 1 ? "" : "s"}: ${names}`,
      messageId: message.id,
      now,
    });
    if (!claim.claimed) {
      console.info("[rotation.duplicate_inbound_skipped]", {
        userId: user._id,
        messageId: message.id,
      });
      return;
    }

    await message.read().catch((caught) => {
      console.warn("[rotation.photo_read_failed]", compactError(caught));
    });

    const existingPhotoCount = await convex.query(api.photos.countForUser, {
      userId: user._id,
    });
    let savedCount = 0;
    const failures: string[] = [];
    for (const photo of photoAttachments) {
      try {
        const bytes = await photo.read();
        await saveUserPhoto({
          userId: user._id,
          bytes,
          mimeType: photo.mimeType,
          name: photo.name,
          size: photo.size ?? bytes.byteLength,
          sourceMessageId: photo.messageId ?? message.id,
        });
        savedCount += 1;
      } catch (caught) {
        const error = compactError(caught);
        failures.push(error);
        console.warn("[rotation.photo_upload_item_failed]", {
          messageId: message.id,
          name: photo.name,
          error,
        });
      }
    }

    if (failures.length) {
      await this.recordFailure(
        "photo_upload",
        user._id,
        {
          messageId: message.id,
          count: photoAttachments.length,
          savedCount,
          failures,
        },
        failures.join("; "),
      );
    }

    const ack = photoUploadAck({
      existingPhotoCount,
      incomingCount: photoAttachments.length,
      savedCount,
      failureCount: failures.length,
    });
    if (ack.reaction) {
      const reacted = await this.tapback(message, ack.reaction, user._id);
      if (reacted && !ack.message) return;
    }
    if (ack.message) {
      await this.withTyping(space, async () => {
        await sendLogged(space, user._id, ack.message as string);
      });
    }
  }

  private async tapback(
    message: Message,
    reaction?: string | null,
    userId?: Id<"users">,
  ) {
    const emoji = normalizeReaction(reaction);
    if (!emoji) return false;
    try {
      await message.react(emoji);
      if (userId) await outbound(userId, `tapback ${emoji}`);
      return true;
    } catch (caught) {
      console.warn("[rotation.tapback_failed]", compactError(caught));
      return false;
    }
  }

  private async withTyping<T>(space: Space, fn: () => Promise<T>) {
    await space.startTyping().catch((caught) => {
      console.warn("[rotation.typing_start_failed]", compactError(caught));
    });
    const keepAlive = setInterval(() => {
      space.startTyping().catch((caught) => {
        console.warn("[rotation.typing_keepalive_failed]", compactError(caught));
      });
    }, 8000);
    try {
      return await fn();
    } finally {
      clearInterval(keepAlive);
      await space.stopTyping().catch((caught) => {
        console.warn("[rotation.typing_stop_failed]", compactError(caught));
      });
    }
  }

  private async sendPaywall(
    space: Space,
    user: Doc<"users">,
    options: { buildingPlaylist?: boolean } = {},
  ) {
    await sendLogged(space, user._id, paywallText(user._id, options));
    const paymentLink = stripePaymentLinkContent(user._id);
    if (!paymentLink) return;
    await sendWithRetry(space, paymentLink);
    await outbound(user._id, "sent stripe payment richlink");
  }

  private async recentConversation(userId: Id<"users">): Promise<ConversationTurn[]> {
    return await convex.query(api.conversation.recentTurns, {
      userId,
      limit: recentConversationLimit,
      since: Date.now() - recentConversationMs,
    });
  }

  private async applyTextingAction(
    space: Space,
    user: Doc<"users">,
    sourceMessage: Message,
    action: TextingAction,
    options?: { fallbackMessage?: string; requireResponse?: boolean },
  ) {
    const formatted = formatTextingAction(action, options?.fallbackMessage);
    let didSomething = false;
    if (formatted.reaction) {
      didSomething =
        (await this.tapback(sourceMessage, formatted.reaction, user._id)) ||
        didSomething;
    }
    if (formatted.message) {
      await this.withTyping(space, async () => {
        await sendLogged(space, user._id, formatted.message as string);
      });
      didSomething = true;
    }
    if (!didSomething && options?.requireResponse && options.fallbackMessage) {
      await this.withTyping(space, async () => {
        await sendLogged(space, user._id, options.fallbackMessage as string);
      });
      didSomething = true;
    }
    return didSomething;
  }

  async deliverInitialPlaylist(space: Space, user: Doc<"users">) {
    if (!user.spotifyLinked || user.initialPlaylistDeliveredAt) return;
    const now = Date.now();
    const isFirstAttempt = !user.initialPlaylistStartedAt;
    const isRecentAttempt =
      Boolean(user.initialPlaylistStartedAt) &&
      now - (user.initialPlaylistStartedAt ?? 0) < initialRetryCooldownMs;
    if (!isFirstAttempt && isRecentAttempt) {
      console.info("[rotation.initial] skip recent attempt", {
        userId: user._id,
        initialPlaylistStartedAt: user.initialPlaylistStartedAt,
      });
      return;
    }
    const sendProgress = isFirstAttempt;
    console.info("[rotation.initial] start", {
      userId: user._id,
      initialPlaylistStartedAt: user.initialPlaylistStartedAt,
      sendProgress,
    });
    if (isFirstAttempt) {
      await sendLogged(space, user._id, fallbackCopy.linked);
      await sendLogged(
        space,
        user._id,
        "btw, totally optional: send favorite photos anytime and i'll use them as playlist covers when they fit.",
      );
      await convex.mutation(api.users.markInitialPlaylistStarted, {
        userId: user._id,
        now: Date.now(),
      });
    } else {
      await convex.mutation(api.users.markInitialPlaylistStarted, {
        userId: user._id,
        now,
      });
    }
    await this.createPlaylistFromPrompt(space, user, {
      prompt:
        "make my first rotation: 75 new songs that fit my spotify taste. use my liked songs as the primary taste evidence, but do not include songs i already have liked or saved. these should not be songs i might like; they should be songs i am almost certain to like based on repeated patterns across my liked songs and strongest playlists. make it a wide cross-genre discovery mix, not one tight theme, but only use genre lanes that are clearly supported by my history. go more niche and deeper-cut than obvious mainstream hits while still choosing near-certain layups.",
      defaultCount: 75,
      requestKind: "initial",
      sendProgress,
    });
    await convex.mutation(api.users.markInitialPlaylistDelivered, {
      userId: user._id,
      now: Date.now(),
    });
    console.info("[rotation.initial] delivered", { userId: user._id });
    const explainer =
      "those first ones are 75 songs each. you can always ask for more. now let's build a custom playlist: text me a mood, activity, artist, playlist, or just ask for more stuff you'd fw and i'll make it.";
    await sendLogged(space, user._id, explainer);
    await sendLogged(
      space,
      user._id,
      "btw, text 1d after a playlist and i'll auto-delete it after 1 day. 36h, 2w, delete after 3 days, etc work too.",
    );
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
      "you've been listening for a minute. what are you doing rn? i'll remember the context for next time.";
    await sendLogged(space, user._id, text);
    await convex.mutation(api.listening.markAskedActivity, {
      sessionId: session._id,
      now: Date.now(),
    });
  }

  private async route(
    space: Space,
    user: Doc<"users">,
    text: string,
    sourceMessage: Message,
    conversationHistory: ConversationTurn[],
  ) {
    if (user.onboardingStage === "new") {
      await this.withTyping(space, async () => {
        await this.sendGreeting(space, user, text);
      });
      return;
    }

    if (!user.spotifyLinked) {
      await this.handlePreSpotify(
        space,
        user,
        text,
        sourceMessage,
        conversationHistory,
      );
      return;
    }

    if (!user.initialPlaylistDeliveredAt) {
      await this.withTyping(space, async () => {
        await this.deliverInitialPlaylist(space, user);
      });
      const latest = await convex.query(api.users.getById, { userId: user._id });
      if (!latest) return;
      user = latest;
    }

    if (wantsPlaylistLinkResend(text)) {
      await this.withTyping(space, async () => {
        await this.resendLatestPlaylistLink(space, user);
      });
      return;
    }

    const pollAnswerHandled = await this.maybeHandlePollAnswer(
      space,
      user,
      text,
      sourceMessage,
      conversationHistory,
    );
    if (pollAnswerHandled) return;

    const autoDelete = playlistAutoDeleteRequest(text);
    if (autoDelete) {
      await this.withTyping(space, async () => {
        await this.schedulePlaylistAutoDelete(space, user, autoDelete, sourceMessage);
      });
      return;
    }

    if (playlistEditIntent(text)) {
      await this.withTyping(space, async () => {
        await this.editExistingPlaylist(space, user, text, sourceMessage, conversationHistory);
      });
      return;
    }

    const directIntent = directPlaylistRequest(text);
    const intent =
      directIntent ??
      (await this.ai.classify({
        message: text,
        conversationHistory,
      }));
    if (!directIntent && intent.intent === "help") {
      const action = await this.ai
        .textingAction({
          kind: "help",
          userText: text,
          fallbackMessage: fallbackCopy.help,
          conversationHistory,
        })
        .catch(() => ({
          mode: "message_only" as const,
          message: fallbackCopy.help,
        }));
      await this.applyTextingAction(space, user, sourceMessage, action, {
        fallbackMessage: fallbackCopy.help,
        requireResponse: true,
      });
      return;
    }

    if (!directIntent && intent.intent === "billing") {
      await this.withTyping(space, async () => {
        if (user.stripeCustomerId || hasActiveSubscription(user)) {
          await sendLogged(space, user._id, await billingPortalText(user));
        } else {
          await this.sendPaywall(space, user);
        }
      });
      return;
    }

    if (!directIntent && intent.intent === "smalltalk" && intent.confidence > 0.78) {
      const fallbackMessage =
        "i'm here. send me a mood, activity, or artist and i'll make the playlist.";
      const action = await this.ai
        .textingAction({
          kind: "smalltalk",
          userText: text,
          fallbackMessage,
          conversationHistory,
        })
        .catch(() => ({
          mode: "message_only" as const,
          message: fallbackMessage,
        }));
      await this.applyTextingAction(space, user, sourceMessage, action, {
        fallbackMessage,
      });
      return;
    }

    const carryoverPoll = carryoverAmbiguityPoll(
      text,
      conversationHistory,
      intent.intent,
    );
    if (carryoverPoll) {
      await this.askPlaylistPoll(space, user, text, carryoverPoll);
      return;
    }

    const shouldGateForPayment =
      Boolean(user.initialPlaylistDeliveredAt) && !hasActiveSubscription(user);
    const mixPoll = shouldGateForPayment ? null : familiarMixPoll(text, intent.intent);
    if (mixPoll) {
      await this.askPlaylistPoll(space, user, text, mixPoll);
      return;
    }

    const workingReaction = playlistWorkingReaction(
      text,
      intent.intent,
      intent.auxiliaryReaction,
    );
    await this.tapback(sourceMessage, workingReaction, user._id);

    if (shouldGateForPayment) {
      await this.withTyping(space, async () => {
        await this.sendPaywall(space, user, { buildingPlaylist: true });
      });
      await convex.mutation(api.users.markPaywallShown, {
        userId: user._id,
        now: Date.now(),
      });
    }

    await this.withTyping(space, async () => {
      await this.createPlaylistFromPrompt(space, user, {
        prompt: text,
        defaultCount: 50,
        requestKind: "user",
        intent: intent.intent,
        deferDeliveryUntilPaid: shouldGateForPayment,
        conversationHistory,
        avoidReaction: workingReaction,
      });
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

  private async handlePreSpotify(
    space: Space,
    user: Doc<"users">,
    text: string,
    sourceMessage: Message,
    conversationHistory: ConversationTurn[],
  ) {
    const unsupportedServiceReply = unsupportedMusicServiceReply(text);
    if (unsupportedServiceReply) {
      await this.withTyping(space, async () => {
        await sendLogged(space, user._id, unsupportedServiceReply);
      });
      return;
    }

    if (wantsSpotifyLink(text)) {
      await this.withTyping(space, async () => {
        await this.sendSpotifyLink(space, user);
      });
      return;
    }

    const action = await this.ai
      .textingAction({
        kind: "pre_spotify_question",
        userText: text,
        fallbackMessage:
          "i can answer questions here, but i need spotify connected before i can make playlists. ask for a fresh link when you're ready.",
        conversationHistory,
      })
      .catch(() => undefined);
    const formatted = action ? formatTextingAction(action) : {};
    if (formatted.reaction) {
      await this.tapback(sourceMessage, formatted.reaction, user._id);
    }
    if (action?.mode === "reaction_only" || action?.mode === "none") return;

    const reply =
      formatted.message ??
      (await this.ai
        .preSpotifyReply(text, conversationHistory)
        .catch(
          () =>
            "i can answer questions here, but i need spotify connected before i can make playlists. ask for a fresh link when you're ready.",
        ));
    await this.withTyping(space, async () => {
      await sendLogged(space, user._id, reply);
    });
  }

  private async sendSpotifyLink(space: Space, user: Doc<"users">, name?: string) {
    const link = await this.spotify.authorizationUrl(user._id);
    const reply = name
      ? `sick, ${name}. connect spotify here so i can get into it`
      : "connect spotify here so i can get into it";
    await sendLogged(space, user._id, reply);
    try {
      await space.send(richlink(link));
      await outbound(user._id, "sent spotify auth richlink");
    } catch (caught) {
      console.warn("[rotation.spotify_auth_richlink_failed]", compactError(caught));
      await outbound(user._id, "spotify auth richlink send failed");
    }
  }

  private async maybeHandlePollAnswer(
    space: Space,
    user: Doc<"users">,
    text: string,
    sourceMessage: Message,
    conversationHistory: ConversationTurn[],
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
          conversationHistory,
        },
        `pick one: ${openPoll.options.map((option, index) => `${index + 1}. ${option}`).join(" / ")}`,
      );
      await this.withTyping(space, async () => {
        await sendLogged(space, user._id, reply);
      });
      return true;
    }

    await convex.mutation(api.conversation.resolvePendingPoll, {
      pollId: openPoll._id,
      selectedOption,
      now: Date.now(),
    });

    const resolvedPrompt = `${openPoll.originalPrompt} ${selectedOption}`;
    if (playlistEditIntent(openPoll.originalPrompt) || playlistEditIntent(resolvedPrompt)) {
      await this.withTyping(space, async () => {
        await this.editExistingPlaylist(
          space,
          user,
          resolvedPrompt,
          sourceMessage,
          conversationHistory,
        );
      });
      return true;
    }

    const workingReaction = playlistWorkingReaction(
      resolvedPrompt,
      "activity_playlist",
    );
    await this.tapback(sourceMessage, workingReaction, user._id);
    await this.withTyping(space, async () => {
      await this.createPlaylistFromPrompt(space, user, {
        prompt: openPoll.originalPrompt,
        pollAnswer: selectedOption,
        defaultCount: 50,
        requestKind: "user",
        deferDeliveryUntilPaid: openPoll.deliveryMode === "after_payment",
        conversationHistory,
        avoidReaction: workingReaction,
      });
    });
    return true;
  }

  private async askPlaylistPoll(
    space: Space,
    user: Doc<"users">,
    text: string,
    playlistPoll: { question: string; options: string[] },
  ) {
    const shouldGateForPayment =
      Boolean(user.initialPlaylistDeliveredAt) && !hasActiveSubscription(user);
    await convex.mutation(api.conversation.createPendingPoll, {
      userId: user._id,
      originalPrompt: text,
      deliveryMode: shouldGateForPayment ? "after_payment" : "immediate",
      question: playlistPoll.question,
      options: playlistPoll.options,
      expiresAt: Date.now() + 30 * 60 * 1000,
      now: Date.now(),
    });
    await this.withTyping(space, async () => {
      await space.send(poll(playlistPoll.question, playlistPoll.options));
      await outbound(
        user._id,
        `${playlistPoll.question} ${playlistPoll.options.join(" / ")}`,
      );
    });
  }

  private async schedulePlaylistAutoDelete(
    space: Space,
    user: Doc<"users">,
    autoDelete: { deleteAt: number; label: string },
    sourceMessage: Message,
  ) {
    const scheduled = await convex.mutation(
      api.playlistExpirations.scheduleForLatestPlaylist,
      {
        userId: user._id,
        deleteAt: autoDelete.deleteAt,
        now: Date.now(),
      },
    );

    if (!scheduled) {
      await sendLogged(
        space,
        user._id,
        "i need a finished playlist to attach that to first. make one, then say 1d or delete after 3 days.",
      );
      return;
    }

    await this.tapback(sourceMessage, "like", user._id);
    const playlistName = scheduled.playlistName ?? "that playlist";
    await sendLogged(
      space,
      user._id,
      `done. i'll delete ${playlistName} after ${autoDelete.label}.`,
    );
  }

  private async editExistingPlaylist(
    space: Space,
    user: Doc<"users">,
    text: string,
    sourceMessage: Message,
    conversationHistory: ConversationTurn[],
  ) {
    const shouldGateForPayment =
      Boolean(user.initialPlaylistDeliveredAt) && !hasActiveSubscription(user);
    if (shouldGateForPayment) {
      await this.sendPaywall(space, user, { buildingPlaylist: true });
      await convex.mutation(api.users.markPaywallShown, {
        userId: user._id,
        now: Date.now(),
      });
      return;
    }

    const context = await this.freshMusicContext(user);
    const target = await this.resolveEditablePlaylist(user, text, context);
    if (!target) {
      await sendLogged(space, user._id, "which playlist should i tweak? send the name or link.");
      return;
    }

    const requestId = await convex.mutation(api.conversation.createRequest, {
      userId: user._id,
      prompt: text,
      intent: "playlist_edit",
      deliveryMode: "immediate",
      now: Date.now(),
    });
    const workingReaction = playlistWorkingReaction(text, "activity_playlist");
    await this.tapback(sourceMessage, workingReaction, user._id);

    try {
      const currentTracks = await this.spotify.getPlaylistTracks(user._id, target.id);
      const targetWithCount = {
        ...target,
        trackCount: currentTracks.length || target.trackCount,
      };
      const plan = await this.ai.playlistEditPlan({
        prompt: text,
        context,
        targetPlaylist: {
          id: targetWithCount.id,
          name: targetWithCount.name,
          description: targetWithCount.description,
          trackCount: targetWithCount.trackCount,
        },
        currentTracks,
        conversationHistory,
      });

      if (plan.needsPoll && plan.pollQuestion && plan.pollOptions?.length) {
        await convex.mutation(api.conversation.createPendingPoll, {
          userId: user._id,
          originalPrompt: text,
          deliveryMode: "immediate",
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
        await convex.mutation(api.conversation.failRequest, {
          requestId,
          error: "playlist edit needs clarification",
          now: Date.now(),
        });
        return;
      }

      let updatedTarget = targetWithCount;
      if (plan.playlistName || plan.playlistDescription !== undefined) {
        updatedTarget = await this.spotify.updatePlaylistDetails(user, updatedTarget, {
          name: plan.playlistName,
          description: plan.playlistDescription,
        });
      }

      let finalTracks: RotationTrack[] | null = null;
      if (plan.action === "remove_tracks") {
        const removeIds = new Set(plan.removeTrackIds);
        if (removeIds.size === 0) {
          await sendLogged(space, user._id, "which tracks should i remove?");
          await convex.mutation(api.conversation.failRequest, {
            requestId,
            error: "playlist edit remove target missing",
            now: Date.now(),
          });
          return;
        }
        finalTracks = currentTracks.filter((track) => !removeIds.has(track.spotifyTrackId));
      } else if (plan.action === "add_tracks" || plan.action === "mixed_update") {
        const addCount = Math.max(1, Math.min(plan.targetCount || 12, 100));
        const removeIds = new Set(plan.removeTrackIds);
        const baseTracks =
          plan.action === "mixed_update"
            ? currentTracks.filter((track) => !removeIds.has(track.spotifyTrackId))
            : currentTracks;
        const additions = await this.tracksForPlaylistEdit({
          user,
          text,
          context,
          currentTracks: baseTracks,
          searchQueries: plan.searchQueries,
          targetCount: addCount,
          newOnly: true,
          conversationHistory,
        });
        finalTracks = uniqueById([
          ...baseTracks,
          ...filterTracksAlreadyPresentBySong(
            uniquePlaylistTracks(additions),
            baseTracks,
          ),
        ]).slice(0, 200);
      } else if (plan.action === "replace_tracks") {
        const targetCount = Math.max(
          8,
          Math.min(plan.targetCount || currentTracks.length || 40, 200),
        );
        const selected = await this.tracksForPlaylistEdit({
          user,
          text,
          context,
          currentTracks,
          searchQueries: plan.searchQueries,
          targetCount,
          keepTrackIds: plan.keepTrackIds,
          newOnly: false,
          conversationHistory,
        });
        finalTracks = uniquePlaylistTracks(selected).slice(0, targetCount);
      }

      if (finalTracks) {
        await this.spotify.replacePlaylistTracks(user, updatedTarget, finalTracks);
        updatedTarget = { ...updatedTarget, trackCount: finalTracks.length };
      }

      await convex.mutation(api.conversation.finishRequest, {
        requestId,
        playlistId: updatedTarget.id,
        playlistUrl: updatedTarget.url,
        trackIds: finalTracks?.map((track) => track.spotifyTrackId) ??
          currentTracks.map((track) => track.spotifyTrackId),
        now: Date.now(),
      });

      const summary = preserveUrlsLowercase(plan.userFacingSummary);
      await this.sendPlaylistLink(space, user, updatedTarget.url);
      await sendLogged(
        space,
        user._id,
        summary ? `updated ${updatedTarget.name}. ${summary}` : `updated ${updatedTarget.name}.`,
      );
    } catch (caught) {
      await convex.mutation(api.conversation.failRequest, {
        requestId,
        error: compactError(caught),
        now: Date.now(),
      });
      if (/spotify api 403|spotify api 404/i.test(compactError(caught))) {
        await sendLogged(space, user._id, "i can't edit that playlist. send one you own or can modify.");
        return;
      }
      throw caught;
    }
  }

  private async tracksForPlaylistEdit(args: {
    user: Doc<"users">;
    text: string;
    context: MusicContext;
    currentTracks: RotationTrack[];
    searchQueries: string[];
    targetCount: number;
    keepTrackIds?: string[];
    newOnly: boolean;
    conversationHistory?: ConversationTurn[];
  }) {
    const currentIds = new Set(args.currentTracks.map((track) => track.spotifyTrackId));
    const queries = args.searchQueries.length ? args.searchQueries : [args.text];
    const candidates = await this.spotify.searchTracks(
      args.user._id,
      queries,
      currentIds,
      Math.min(300, Math.max(80, args.targetCount * 4)),
    );
    const selectionPlan: Awaited<ReturnType<RotationAi["playlistPlan"]>> = {
      needsPoll: false,
      playlistName: "playlist edit",
      playlistDescription: args.text,
      targetCount: args.targetCount,
      searchQueries: queries,
      familiarTrackIds: args.keepTrackIds ?? [],
      vibe: args.text,
      userFacingSummary: args.text,
    };
    const selected = await this.selectTracks(
      args.text,
      selectionPlan,
      candidates,
      args.currentTracks,
      args.newOnly,
      undefined,
      args.conversationHistory,
    );

    if (!args.keepTrackIds?.length) return selected;
    const keepIds = new Set(args.keepTrackIds);
    const kept = args.currentTracks.filter((track) => keepIds.has(track.spotifyTrackId));
    return uniqueById([...kept, ...selected]).slice(0, args.targetCount);
  }

  private async resolveEditablePlaylist(
    user: Doc<"users">,
    text: string,
    context: MusicContext,
  ): Promise<EditablePlaylist | null> {
    const linkedId = spotifyPlaylistIdFromText(text);
    if (linkedId) {
      const cached = context.playlists.find(
        (playlist) => playlist.spotifyPlaylistId === linkedId,
      );
      return {
        id: linkedId,
        name: cached?.name ?? "playlist",
        description: cached?.description,
        trackCount: cached?.trackCount ?? 0,
        url: cached?.externalUrl ?? `https://open.spotify.com/playlist/${linkedId}`,
      };
    }

    const named = this.resolvePlaylistByName(text, context);
    if (named) return named;

    const latest = await convex.query(api.conversation.latestCompletedPlaylistRequest, {
      userId: user._id,
    });
    if (!latest?.playlistId || !latest.playlistUrl) return null;
    const cached = context.playlists.find(
      (playlist) => playlist.spotifyPlaylistId === latest.playlistId,
    );
    return {
      id: latest.playlistId,
      name: cached?.name ?? "last playlist",
      description: cached?.description,
      trackCount: cached?.trackCount ?? latest.trackIds?.length ?? 0,
      url: latest.playlistUrl,
    };
  }

  private resolvePlaylistByName(
    text: string,
    context: MusicContext,
  ): EditablePlaylist | null {
    const cleanText = normalize(text);
    const explicitName = quotedPlaylistName(text);
    const cleanName = explicitName ? normalize(explicitName) : undefined;
    const scored = context.playlists
      .map((playlist) => {
        const name = normalize(playlist.name);
        let score = 0;
        if (cleanName && name === cleanName) score += 100;
        if (cleanName && name.includes(cleanName)) score += 70;
        if (name && cleanText.includes(name)) score += 65;
        return { playlist, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    const best = scored[0]?.playlist;
    if (!best) return null;
    return {
      id: best.spotifyPlaylistId,
      name: best.name,
      description: best.description,
      trackCount: best.trackCount,
      url: best.externalUrl ?? `https://open.spotify.com/playlist/${best.spotifyPlaylistId}`,
    };
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
      precomputedPlan?: Awaited<ReturnType<RotationAi["playlistPlan"]>>;
      precomputedContext?: MusicContext;
      conversationHistory?: ConversationTurn[];
      avoidReaction?: string | null;
    },
  ) {
    const requestId = await convex.mutation(api.conversation.createRequest, {
      userId: user._id,
      prompt: args.prompt,
      intent: args.intent ?? args.requestKind,
      deliveryMode: args.deferDeliveryUntilPaid ? "after_payment" : "immediate",
      now: Date.now(),
    });

    let playlistLinkSent = false;
    let tasteProgressSent = false;
    let readySoonProgressSent = false;
    let progressMessages: string[] = [];
    let readySoonProgressTimer: ReturnType<typeof setTimeout> | undefined;

    const sendProgressMessage = async (message?: string) => {
      const trimmed = message?.trim();
      if (playlistLinkSent || !trimmed) return;
      await sendLogged(space, user._id, trimmed);
    };

    const captureProgressMessages = async (context: MusicContext) => {
      if (playlistLinkSent || tasteProgressSent) return;
      const messages = await this.ai.tasteProgressMessages(context).catch((caught) => {
        console.warn("[rotation.progress_messages_failed]", compactError(caught));
        return [];
      });
      progressMessages = messages;
      if (messages[0]) {
        tasteProgressSent = true;
        await sendProgressMessage(messages[0]).catch((caught) => {
          tasteProgressSent = false;
          console.warn("[rotation.initial_progress_failed]", compactError(caught));
        });
      }
    };

    try {
      if (args.sendProgress) {
        readySoonProgressTimer = setTimeout(() => {
          if (playlistLinkSent || readySoonProgressSent) return;
          readySoonProgressSent = true;
          void sendProgressMessage(
            formatReadySoonProgressMessage(progressMessages[1]),
          ).catch((caught) => {
            readySoonProgressSent = false;
            console.warn("[rotation.delayed_progress_failed]", compactError(caught));
          });
        }, readySoonProgressMs);
        readySoonProgressTimer.unref?.();
      }

      const context = args.precomputedContext ?? (await this.freshMusicContext(user));
      if (args.sendProgress) {
        void captureProgressMessages(context);
      }
      const newOnly = shouldUseNewOnly(args);
      const providers = playlistProviders();
      const providerPlanResults = await Promise.allSettled(
        providers.map(async (provider) => {
          const rawPlan =
            provider === "gemini" && args.precomputedPlan
              ? args.precomputedPlan
              : await this.ai.playlistPlan({
                  prompt: args.prompt,
                  context,
                  defaultCount: args.defaultCount,
                  pollAnswer: args.pollAnswer,
                  newOnly,
                  fixedTargetCount: args.requestKind !== "user",
                  conversationHistory: args.conversationHistory,
                  provider,
                });
          return {
            provider,
            label: playlistProviderLabel(provider),
            plan:
              args.requestKind === "user"
                ? rawPlan
                : { ...rawPlan, targetCount: args.defaultCount },
          };
        }),
      );
      const providerPlans = providerPlanResults.flatMap((result, index) => {
        const provider = providers[index] ?? "gemini";
        if (result.status === "fulfilled") return [result.value];
        console.warn("[rotation.playlist_plan_failed]", {
          provider,
          error: compactError(result.reason),
        });
        return [];
      });
      const pollPlan = providerPlans.find(
        ({ plan }) => plan.needsPoll && plan.pollQuestion && plan.pollOptions?.length,
      )?.plan;
      if (
        pollPlan?.needsPoll &&
        pollPlan.pollQuestion &&
        pollPlan.pollOptions?.length &&
        !args.pollAnswer
      ) {
        await convex.mutation(api.conversation.createPendingPoll, {
          userId: user._id,
          originalPrompt: args.prompt,
          deliveryMode: args.deferDeliveryUntilPaid ? "after_payment" : "immediate",
          question: pollPlan.pollQuestion,
          options: pollPlan.pollOptions,
          expiresAt: Date.now() + 30 * 60 * 1000,
          now: Date.now(),
        });
        await space.send(poll(pollPlan.pollQuestion, pollPlan.pollOptions));
        await outbound(
          user._id,
          `${pollPlan.pollQuestion} ${pollPlan.pollOptions.join(" / ")}`,
        );
        return;
      }

      const primaryPlan = providerPlans[0]?.plan;
      if (!primaryPlan) throw new Error("no playlist plans generated");
      const coverPromise = this.preparePlaylistCover(
        user._id,
        args.prompt,
        primaryPlan,
      ).catch((caught) => {
        console.warn("[rotation.cover_prepare_failed]", compactError(caught));
        return null;
      });
      const variantResults = await Promise.allSettled(
        providerPlans.map(({ provider, label, plan }) =>
          this.createPlaylistVariant({
            provider,
            label,
            user,
            prompt: args.prompt,
            requestKind: args.requestKind,
            pollAnswer: args.pollAnswer,
            plan,
            context,
            newOnly,
            conversationHistory: args.conversationHistory,
          }),
        ),
      );
      const variants = variantResults.flatMap((result, index) => {
        const provider = providerPlans[index]?.provider ?? "gemini";
        if (result.status === "fulfilled") return [result.value];
        console.warn("[rotation.playlist_variant_failed]", {
          provider,
          error: compactError(result.reason),
        });
        return [];
      });
      if (variants.length === 0) throw new Error("no playlist variants created");
      const cover = await coverPromise;
      if (cover) {
        let markedPhotoUsed = false;
        await Promise.all(
          variants.map(async (variant) => {
            await this.spotify
              .uploadPlaylistCover(user._id, variant.playlist.id, cover.jpeg)
              .then(async () => {
                if (!markedPhotoUsed) {
                  markedPhotoUsed = true;
                  await markPhotoUsed(
                    cover.photoId,
                    variant.playlist.id,
                    variant.playlist.name,
                  );
                }
              })
              .catch((caught) => {
                console.warn("[rotation.cover_upload_failed]", {
                  provider: variant.provider,
                  error: compactError(caught),
                });
              });
          }),
        );
      }
      const primary = variants[0];
      if (!primary) throw new Error("no playlist variants created");

      await convex.mutation(api.conversation.finishRequest, {
        requestId,
        playlistId: primary.playlist.id,
        playlistUrl: primary.playlist.url,
        trackIds: primary.selected.map((track) => track.spotifyTrackId),
        playlistVariants: variants.map((variant) => ({
          provider: variant.provider,
          label: variant.label,
          playlistId: variant.playlist.id,
          playlistUrl: variant.playlist.url,
          playlistName: variant.playlist.name,
          trackIds: variant.selected.map((track) => track.spotifyTrackId),
        })),
        now: Date.now(),
      });

      const reply =
        args.requestKind === "initial"
          ? "first rotation is ready. lmk what you think."
          : formatPlaylistReadyReply(
              await this.safeReply(
                {
                  kind: "playlist_ready",
                  userText: args.prompt,
                  playlistName: primary.playlist.name,
                  extra: primary.plan.userFacingSummary,
                  conversationHistory: args.conversationHistory,
                },
                `made ${primary.playlist.name}. lmk what you think.`,
              ),
              `made ${primary.playlist.name}. lmk what you think.`,
              args.avoidReaction,
            );
      const latestUser =
        args.deferDeliveryUntilPaid && args.requestKind === "user"
          ? await convex.query(api.users.getById, { userId: user._id })
          : user;
      const canDeliverNow =
        !args.deferDeliveryUntilPaid ||
        (latestUser ? hasActiveSubscription(latestUser) : false);

      if (canDeliverNow) {
        playlistLinkSent = true;
        if (readySoonProgressTimer) clearTimeout(readySoonProgressTimer);
        await sendLogged(space, user._id, reply);
        await this.sendPlaylistVariants(space, user, variants, {
          includeVotePoll: variants.length > 1,
        });
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
    } finally {
      if (readySoonProgressTimer) clearTimeout(readySoonProgressTimer);
    }
  }

  private async freshMusicContext(user: Doc<"users">) {
    const userId = user._id;
    let context = await this.fullMusicContext(userId);
    let spotifyUserId = context.user?.spotifyUserId ?? user.spotifyUserId;
    if (user.spotifyLinked && !spotifyUserId) {
      void this.refreshSpotifyProfile(userId);
    }
    if (!hasFreshSync(context.user, context)) {
      console.info("[rotation.context] syncing spotify library", {
        userId,
        existingTracks: context.tracks.length,
      });
      await this.spotify.syncUserLibrary(userId, spotifyUserId);
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
      void this.updateTasteSummary(userId, context);
    }

    return context;
  }

  private async refreshSpotifyProfile(userId: Id<"users">) {
    try {
      const profile = await this.spotify.currentUserProfile(userId);
      await convex.mutation(api.spotify.saveProfile, {
        userId,
        spotifyUserId: profile.id,
        spotifyDisplayName: profile.display_name,
        spotifyEmail: profile.email,
        defaultMarket: profile.country,
        now: Date.now(),
      });
      return profile.id;
    } catch (caught) {
      console.warn("[rotation.context] spotify profile refresh failed", {
        userId,
        error: compactError(caught),
      });
      return undefined;
    }
  }

  private async updateTasteSummary(userId: Id<"users">, context: MusicContext) {
    try {
      const summary = await this.ai.summarizeTaste(context);
      await convex.mutation(api.users.updateTasteSummary, {
        userId,
        tasteSummary: summary.tasteSummary,
        activityPreferencesJson: summary.activityPreferences
          ? JSON.stringify(summary.activityPreferences)
          : undefined,
        now: Date.now(),
      });
    } catch (caught) {
      console.warn("[rotation.context] summarize taste failed", {
        userId,
        error: compactError(caught),
      });
    }
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

  private async createPlaylistVariant(args: {
    provider: PlaylistAiProvider;
    label: string;
    user: Doc<"users">;
    prompt: string;
    requestKind: "initial" | "weekly" | "user";
    pollAnswer?: string;
    plan: PlaylistPlan;
    context: MusicContext;
    newOnly: boolean;
    conversationHistory?: ConversationTurn[];
  }): Promise<PlaylistVariantResult> {
    const finalTargetCount = args.plan.targetCount;
    const selectionPlan =
      args.requestKind === "initial"
        ? {
            ...args.plan,
            targetCount: Math.min(200, Math.max(args.plan.targetCount, 80)),
          }
        : args.plan;
    const knownTrackIds = new Set(
      args.context.tracks.map((track) => track.spotifyTrackId),
    );
    const openerQuery = explicitOpenerQuery(args.prompt);
    const searchQueries = openerQuery
      ? [
          openerQuery,
          ...args.plan.searchQueries.filter(
            (query) => normalize(query) !== normalize(openerQuery),
          ),
        ]
      : args.plan.searchQueries;
    const rawCandidates = await this.spotify.searchTracks(
      args.user._id,
      searchQueries,
      knownTrackIds,
      Math.min(600, Math.max(240, selectionPlan.targetCount * 3)),
    );
    const candidates = args.newOnly
      ? rankDiscoveryCandidates(rawCandidates)
      : rawCandidates;
    const familiarTracks = this.familiarTracks(
      args.context.tracks,
      args.plan.familiarTrackIds,
    );
    const familiarPercent = familiarMixPercent(args.pollAnswer);
    const allowSameArtistTitleRepeats = allowsRepeatedSongVersions(args.prompt);
    const selectedWithBuffer = finalizeSelectedTracks(
      await this.selectTracks(
        args.prompt,
        selectionPlan,
        candidates,
        familiarTracks,
        args.newOnly,
        familiarPercent,
        args.conversationHistory,
      ),
      [...args.context.tracks, ...candidates, ...familiarTracks],
      openerQuery,
    );
    const selectedPool = args.newOnly
      ? uniquePlaylistTracks(
          [
            ...filterKnownLibraryTracks(selectedWithBuffer, args.context.tracks),
            ...filterKnownLibraryTracks(candidates, args.context.tracks),
          ],
          { allowSameArtistTitleRepeats },
        )
      : applyFamiliarMix({
          selected: selectedWithBuffer,
          candidates,
          familiarTracks,
          targetCount: finalTargetCount,
          familiarPercent,
          allowSameArtistTitleRepeats,
        });
    const selected =
      args.requestKind === "initial"
        ? enforcePlaylistDiversity(selectedPool, {
            maxPerAlbum: 2,
            maxPerArtist: 4,
          }).slice(0, finalTargetCount)
        : selectedPool.slice(0, finalTargetCount);

    if (selected.length === 0) {
      throw new Error(`no tracks selected for ${args.label}`);
    }

    const playlist = await this.spotify.createPlaylist(args.user, {
      name: args.plan.playlistName,
      description: args.plan.playlistDescription,
      tracks: selected,
    });

    return {
      provider: args.provider,
      label: args.label,
      plan: args.plan,
      selected,
      playlist,
    };
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
      .filter(
        (track) =>
          track.source === "saved" ||
          track.source === "top" ||
          track.source === "playlist" ||
          track.sources?.some((source) =>
            source === "saved" || source === "top" || source === "playlist",
          ),
      )
      .sort((left, right) => (right.tasteWeight ?? 0) - (left.tasteWeight ?? 0));
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
    familiarMixPercent?: number,
    conversationHistory?: ConversationTurn[],
  ) {
    const chosen = await this.ai.chooseTracks({
      prompt,
      plan,
      candidates,
      familiarTracks,
      newOnly,
      familiarMixPercent,
      conversationHistory,
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

  private async preparePlaylistCover(
    userId: Id<"users">,
    prompt: string,
    plan: Awaited<ReturnType<RotationAi["playlistPlan"]>>,
  ): Promise<{ photoId: Id<"userPhotos">; jpeg: Buffer } | null> {
    const photos = await listUnusedUserPhotos(userId);
    if (photos.length === 0) return null;

    const candidates: CoverPhotoCandidate[] = [];
    for (const photo of photos) {
      try {
        const originalBytes = await fetchPhotoBytes(photo);
        const modelBytes = await modelPhotoJpeg(originalBytes);
        candidates.push({
          id: photo._id,
          photoId: photo._id,
          name: photo.name,
          mimeType: photo.mimeType,
          uploadedAt: photo.createdAt,
          originalBytes,
          modelBytes,
        });
      } catch (caught) {
        console.warn("[rotation.photo_fetch_failed]", {
          photoId: photo._id,
          error: compactError(caught),
        });
      }
    }

    if (candidates.length === 0) return null;

    const selection = await this.ai.chooseCoverPhoto({
      userPrompt: prompt,
      playlistName: plan.playlistName,
      playlistDescription: plan.playlistDescription,
      vibe: plan.vibe,
      userFacingSummary: plan.userFacingSummary,
      photos: candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        mimeType: candidate.mimeType,
        uploadedAt: candidate.uploadedAt,
        bytes: candidate.modelBytes,
      })),
    });

    console.info("[rotation.cover_selection]", {
      userId,
      selectedPhotoId: selection.selectedPhotoId,
      confidence: selection.confidence,
      reason: selection.reason,
      candidateCount: candidates.length,
    });

    if (!selection.selectedPhotoId || selection.confidence < 0.2) return null;
    const selected = candidates.find(
      (candidate) => candidate.id === selection.selectedPhotoId,
    );
    if (!selected) return null;

    return {
      photoId: selected.photoId,
      jpeg: await spotifyCoverJpeg(selected.originalBytes),
    };
  }

  private async maybeSendPaywall(space: Space, user: Doc<"users">) {
    if (!user.hasSeenPaywall && user.completedRequestCount === 0) {
      await this.sendPaywall(space, user);
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

  private async resendLatestPlaylistLink(space: Space, user: Doc<"users">) {
    const request = await convex.query(api.conversation.latestCompletedPlaylistRequest, {
      userId: user._id,
    });

    const variants = request ? this.requestPlaylistVariants(request) : [];
    if (!request || variants.length === 0) {
      await sendLogged(
        space,
        user._id,
        "i don't have a finished playlist link to resend yet. once it's made, it'll also be at the top of your spotify library.",
      );
      return;
    }

    const isPaidUndelivered =
      request.deliveryMode === "after_payment" && !request.deliveredAt;
    if (isPaidUndelivered && !hasActiveSubscription(user)) {
      await this.sendPaywall(space, user, { buildingPlaylist: true });
      await convex.mutation(api.users.markPaywallShown, {
        userId: user._id,
        now: Date.now(),
      });
      return;
    }

    await sendLogged(
      space,
      user._id,
      "resent it. if imessage drops the preview, it's also at the top of your spotify library.",
    );
    await this.sendPlaylistVariants(space, user, variants);
    if (!request.deliveredAt) {
      await convex.mutation(api.conversation.markRequestDelivered, {
        requestId: request._id,
        now: Date.now(),
      });
    }
  }

  private async sendPlaylistLink(space: Space, user: Doc<"users">, url: string) {
    try {
      await space.send(playlistLinkContent(url));
      await outbound(user._id, "sent playlist richlink");
    } catch (caught) {
      console.warn("[rotation.playlist_richlink_failed]", compactError(caught));
      await outbound(user._id, `playlist richlink send failed: ${url}`);
    }
  }

  private requestPlaylistVariants(request: Doc<"recommendationRequests">) {
    if (request.playlistVariants?.length) {
      return request.playlistVariants.map((variant) => ({
        label: variant.label,
        playlist: {
          name: variant.playlistName,
          url: variant.playlistUrl,
        },
      }));
    }
    if (!request.playlistUrl) return [];
    return [
      {
        label: "playlist",
        playlist: {
          name: "playlist",
          url: request.playlistUrl,
        },
      },
    ];
  }

  private async sendPlaylistVariants(
    space: Space,
    user: Doc<"users">,
    variants: Array<{
      label: string;
      playlist: { name: string; url: string };
    }>,
    options: { includeVotePoll?: boolean } = {},
  ) {
    if (variants.length > 1) {
      await sendLogged(space, user._id, "made two versions. vote after you listen.");
    }
    for (const [index, variant] of variants.entries()) {
      if (variants.length > 1) {
        await sendLogged(
          space,
          user._id,
          `${ordinalLabel(index)}: ${variant.playlist.name}`,
        );
      }
      await this.sendPlaylistLink(space, user, variant.playlist.url);
    }
    if (options.includeVotePoll && variants.length > 1) {
      const voteOptions = playlistVoteOptions(
        variants.map((variant) => variant.playlist.name),
      );
      await space.send(poll("which one did you like more?", voteOptions));
      await outbound(
        user._id,
        `which one did you like more? ${voteOptions.join(" / ")}`,
      );
    }
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

    const variants = readyRequest ? this.requestPlaylistVariants(readyRequest) : [];
    if (readyRequest && variants.length > 0) {
      await sendLogged(space, user._id, "your playlist is ready.");
      await this.sendPlaylistVariants(space, user, variants, {
        includeVotePoll: variants.length > 1,
      });
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

export const createRotationBot = (options?: { attachmentFetcher?: AttachmentFetcher }) =>
  new RotationBot(new RotationAi(), new SpotifyService(), options?.attachmentFetcher);

export type RotationApp = SpectrumInstance;

export const nextWeeklyDueAt = () => Date.now() + weekMs;
