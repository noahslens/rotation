import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";
import { env, requireEnv } from "../config/env";
import { decryptToken, encryptToken } from "../utils/tokenCrypto";

const accountsBaseUrl = "https://accounts.spotify.com";
const apiBaseUrl = "https://api.spotify.com/v1";
const refreshSkewMs = 90_000;
const snapshotTrackBatchSize = 400;
const spotifyPageConcurrency = 3;
const spotifyPlaylistTrackConcurrency = 2;
const spotifyRequestTimeoutMs = 20_000;

export const spotifyScopes = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-currently-playing",
  "user-read-playback-state",
  "playlist-modify-public",
  "playlist-modify-private",
  "ugc-image-upload",
];

export type RotationTrack = {
  spotifyTrackId: string;
  name: string;
  artists: string[];
  album?: string;
  uri: string;
  externalUrl?: string;
  popularity?: number;
  durationMs?: number;
  explicit?: boolean;
  previewUrl?: string;
  source: "saved" | "playlist" | "top" | "recommendation" | "created";
  sources?: Array<RotationTrack["source"]>;
  playlistIds?: string[];
  playlistCount?: number;
  tasteWeight?: number;
};

export type CandidateTrack = RotationTrack & {
  searchQuery?: string;
  matchScore?: number;
};

export type CreatedPlaylist = {
  id: string;
  name: string;
  url: string;
  uri: string;
};

export type EditablePlaylist = {
  id: string;
  name: string;
  url: string;
  description?: string;
  trackCount: number;
};

type SpotifyImage = { url: string };
type SpotifyExternalUrls = { spotify?: string };
type SpotifyArtist = { id: string; name: string };
type SpotifyAlbum = { name?: string; images?: SpotifyImage[] };
type SpotifyTrack = {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album?: SpotifyAlbum;
  uri: string;
  external_urls?: SpotifyExternalUrls;
  popularity?: number;
  duration_ms?: number;
  explicit?: boolean;
  preview_url?: string | null;
  is_local?: boolean;
};

type SpotifyPlaylist = {
  id: string;
  name: string;
  description?: string | null;
  owner?: { id?: string; display_name?: string };
  tracks?: { total?: number };
  snapshot_id?: string;
  public?: boolean;
  external_urls?: SpotifyExternalUrls;
  uri?: string;
};

export type SpotifyProfile = {
  id: string;
  display_name?: string;
  email?: string;
  country?: string;
};

type Page<T> = {
  items: T[];
  next: string | null;
};

type TotalPage<T> = Page<T> & {
  total?: number;
};

const compactDescription = (value: string | null | undefined) => {
  if (!value) return undefined;
  const withoutTags = value.replace(/<[^>]+>/g, "").trim();
  return withoutTags || undefined;
};

const compactError = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught);

const spotifyPlainText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export const spotifyDescriptionText = (value: string) =>
  spotifyPlainText(value)
    .replace(
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen))?(?:\s+[a-z]+){0,2}\s*(?:songs?|tracks?|picks?|cuts?)\b[,.:\s-]*/gi,
      "",
    )
    .replace(/\b\d{1,3}(?:\s+[a-z]+){0,2}\s*(?:songs?|tracks?|picks?|cuts?)\b[,.:\s-]*/g, "")
    .replace(
      /\b(?:song|track|pick|cut)\s*(?:count|total|amount)\b[,.:\s-]*/g,
      "",
    )
    .replace(/\b(?:targetcount|defaulttargetcount)\b[,.:\s-]*/g, "")
    .replace(/\s+([,.])/g, "$1")
    .replace(/^[,.\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const searchableText = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft|featuring)\.?\b/g, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (value: string) =>
  new Set(searchableText(value).split(" ").filter((token) => token.length > 1));

const tokenCoverage = (needle: string, haystack: string) => {
  const needleTokens = tokenSet(needle);
  if (needleTokens.size === 0) return 0;
  const haystackTokens = tokenSet(haystack);
  let hits = 0;
  for (const token of needleTokens) {
    if (haystackTokens.has(token)) hits += 1;
  }
  return hits / needleTokens.size;
};

const stripListPrefix = (value: string) =>
  value
    .replace(/^\s*\d+[\).\-\s]+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();

export const parseSongPick = (pick: string) => {
  const clean = stripListPrefix(pick)
    .replace(/\s+[–—]\s+/g, " - ")
    .replace(/\s+\|\s+/g, " - ")
    .trim();
  const byMatch = clean.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      artist: byMatch[2]?.trim(),
      title: byMatch[1]?.trim(),
      text: clean,
    };
  }
  const dashIndex = clean.indexOf(" - ");
  if (dashIndex > 0) {
    return {
      artist: clean.slice(0, dashIndex).trim(),
      title: clean.slice(dashIndex + 3).trim(),
      text: clean,
    };
  }
  return {
    artist: undefined,
    title: undefined,
    text: clean,
  };
};

export const songPickToSpotifyQuery = (pick: string) => {
  const parsed = parseSongPick(pick);
  if (parsed.artist && parsed.title) {
    return `track:${parsed.title} artist:${parsed.artist}`;
  }
  return parsed.text;
};

export const spotifySongMatchScore = (
  pick: string,
  track: Pick<RotationTrack, "name" | "artists" | "album" | "popularity">,
  index = 0,
) => {
  const parsed = parseSongPick(pick);
  const artistText = track.artists.join(" ");
  const titleScore = parsed.title ? tokenCoverage(parsed.title, track.name) : 0;
  const artistScore = parsed.artist ? tokenCoverage(parsed.artist, artistText) : 0;
  const combinedScore = tokenCoverage(
    parsed.text,
    `${track.name} ${artistText} ${track.album ?? ""}`,
  );
  const popularityTieBreaker = Math.min(0.04, (track.popularity ?? 0) / 2500);
  const rankPenalty = index * 0.015;

  if (parsed.artist && parsed.title) {
    return (
      titleScore * 0.56 +
      artistScore * 0.34 +
      combinedScore * 0.1 +
      popularityTieBreaker -
      rankPenalty
    );
  }

  return combinedScore + popularityTieBreaker - rankPenalty;
};

const mapTrack = (
  track: SpotifyTrack | null | undefined,
  source: RotationTrack["source"],
  playlistIds?: string[],
): RotationTrack | null => {
  if (!track?.id || !track.uri || track.is_local) return null;
  return {
    spotifyTrackId: track.id,
    name: track.name,
    artists: track.artists?.map((artist) => artist.name).filter(Boolean) ?? [],
    album: track.album?.name,
    uri: track.uri,
    externalUrl: track.external_urls?.spotify,
    popularity: track.popularity,
    durationMs: track.duration_ms,
    explicit: track.explicit,
    previewUrl: track.preview_url ?? undefined,
    source,
    sources: [source],
    playlistIds,
    playlistCount: playlistIds?.length,
  };
};

const dedupeTracks = (tracks: RotationTrack[]) => {
  const byId = new Map<string, RotationTrack>();
  for (const track of tracks) {
    const existing = byId.get(track.spotifyTrackId);
    if (!existing) {
      byId.set(track.spotifyTrackId, {
        ...track,
        sources: track.sources ?? [track.source],
        playlistIds: track.playlistIds ?? [],
        playlistCount: track.playlistIds?.length ?? track.playlistCount,
      });
      continue;
    }

    const playlistIds = Array.from(
      new Set([...(existing.playlistIds ?? []), ...(track.playlistIds ?? [])]),
    );
    const sources = Array.from(
      new Set([...(existing.sources ?? [existing.source]), ...(track.sources ?? [track.source])]),
    );
    byId.set(track.spotifyTrackId, {
      ...existing,
      playlistIds,
      sources,
      playlistCount: playlistIds.length || existing.playlistCount || track.playlistCount,
    });
  }
  return [...byId.values()];
};

export class SpotifyService {
  redirectUri() {
    return `${requireEnv("convexSiteUrl")}/auth/spotify/callback`;
  }

  async authorizationUrl(userId: Id<"users">) {
    const state = crypto.randomUUID();
    const now = Date.now();
    await convex.mutation(api.spotify.createAuthState, {
      userId,
      state,
      expiresAt: now + 15 * 60 * 1000,
      now,
    });

    const url = new URL(`${accountsBaseUrl}/authorize`);
    url.searchParams.set("client_id", requireEnv("spotifyClientId"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.redirectUri());
    url.searchParams.set("scope", spotifyScopes.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async syncUserLibrary(userId: Id<"users">, spotifyUserId?: string) {
    console.info("[spotify.sync] start", { userId });
    const [playlists, savedTracks, topTracks] = await Promise.all([
      this.getPlaylists(userId),
      this.getSavedTracks(userId),
      this.getTopTracks(userId),
    ]);
    console.info("[spotify.sync] fetched library", {
      userId,
      playlists: playlists.length,
      savedTracks: savedTracks.length,
      topTracks: topTracks.length,
    });

    const playlistSnapshot = playlists.map((playlist) => ({
      spotifyPlaylistId: playlist.id,
      name: playlist.name,
      description: compactDescription(playlist.description),
      ownerId: playlist.owner?.id,
      ownerName: playlist.owner?.display_name,
      trackCount: playlist.tracks?.total ?? 0,
      snapshotId: playlist.snapshot_id,
      public: playlist.public,
      externalUrl: playlist.external_urls?.spotify,
    }));

    await convex.mutation(api.spotify.saveSnapshot, {
      userId,
      playlists: playlistSnapshot,
      tracks: [],
      markSynced: false,
      now: Date.now(),
    });

    const seedTracks = dedupeTracks([...savedTracks, ...topTracks]);
    for (let index = 0; index < seedTracks.length; index += snapshotTrackBatchSize) {
      console.info("[spotify.sync] saving seed track batch", {
        userId,
        from: index,
        to: Math.min(index + snapshotTrackBatchSize, seedTracks.length),
        total: seedTracks.length,
      });
      await convex.mutation(api.spotify.saveSnapshot, {
        userId,
        playlists: [],
        tracks: seedTracks.slice(index, index + snapshotTrackBatchSize),
        markSynced: false,
        now: Date.now(),
      });
    }

    const ownedPlaylists = spotifyUserId
      ? playlists.filter((playlist) => playlist.owner?.id === spotifyUserId)
      : [];
    const playlistTracks = await this.getTracksFromPlaylists(
      userId,
      this.weightPlaylistsForTaste(ownedPlaylists, spotifyUserId),
    );
    const tracks = dedupeTracks([...seedTracks, ...playlistTracks]);
    console.info("[spotify.sync] fetched playlist tracks", {
      userId,
      playlistTracks: playlistTracks.length,
      ownedPlaylists: ownedPlaylists.length,
      dedupedTracks: tracks.length,
    });

    for (let index = 0; index < playlistTracks.length; index += snapshotTrackBatchSize) {
      console.info("[spotify.sync] saving playlist track batch", {
        userId,
        from: index,
        to: Math.min(index + snapshotTrackBatchSize, playlistTracks.length),
        total: playlistTracks.length,
      });
      await convex.mutation(api.spotify.saveSnapshot, {
        userId,
        playlists: [],
        tracks: playlistTracks.slice(index, index + snapshotTrackBatchSize),
        markSynced: index + snapshotTrackBatchSize >= playlistTracks.length,
        now: Date.now(),
      });
    }

    if (playlistTracks.length === 0) {
      await convex.mutation(api.spotify.saveSnapshot, {
        userId,
        playlists: [],
        tracks: [],
        markSynced: true,
        now: Date.now(),
      });
    }

    console.info("[spotify.sync] complete", {
      userId,
      playlists: playlists.length,
      savedTracks: savedTracks.length,
      playlistTracks: playlistTracks.length,
      tracks: tracks.length,
    });

    return {
      playlists: playlists.length,
      tracks: tracks.length,
      savedTracks: savedTracks.length,
      playlistTracks: playlistTracks.length,
    };
  }

  async currentUserProfile(userId: Id<"users">) {
    return await this.request<SpotifyProfile>(userId, "/me");
  }

  async searchTracks(
    userId: Id<"users">,
    queries: string[],
    knownTrackIds: Set<string>,
    maxCandidates = 180,
  ) {
    const candidates: CandidateTrack[] = [];
    const seen = new Set(knownTrackIds);

    for (const query of queries.slice(0, 40)) {
      const params = new URLSearchParams({
        q: query,
        type: "track",
        limit: "10",
        market: "from_token",
      });
      const payload = await this.request<{ tracks?: { items?: SpotifyTrack[] } }>(
        userId,
        `/search?${params.toString()}`,
      );
      for (const item of payload.tracks?.items ?? []) {
        const mapped = mapTrack(item, "recommendation");
        if (!mapped || seen.has(mapped.spotifyTrackId)) continue;
        seen.add(mapped.spotifyTrackId);
        candidates.push({ ...mapped, searchQuery: query });
        if (candidates.length >= maxCandidates) return candidates;
      }
    }

    return candidates;
  }

  async resolveSongPicks(
    userId: Id<"users">,
    songPicks: string[],
    knownTrackIds: Set<string>,
    maxCandidates = 180,
  ) {
    const candidates: CandidateTrack[] = [];
    const seen = new Set(knownTrackIds);
    const normalizedPicks = Array.from(
      new Set(songPicks.map((pick) => stripListPrefix(pick)).filter(Boolean)),
    );

    for (const pick of normalizedPicks.slice(0, 240)) {
      const queries = Array.from(
        new Set([songPickToSpotifyQuery(pick), parseSongPick(pick).text].filter(Boolean)),
      );
      const matches: Array<{ track: RotationTrack; score: number }> = [];

      for (const query of queries) {
        const params = new URLSearchParams({
          q: query,
          type: "track",
          limit: "10",
          market: "from_token",
        });
        const payload = await this.request<{ tracks?: { items?: SpotifyTrack[] } }>(
          userId,
          `/search?${params.toString()}`,
        );
        for (const [index, item] of (payload.tracks?.items ?? []).entries()) {
          const mapped = mapTrack(item, "recommendation");
          if (!mapped || seen.has(mapped.spotifyTrackId)) continue;
          matches.push({
            track: mapped,
            score: spotifySongMatchScore(pick, mapped, index),
          });
        }
        if (matches.some((match) => match.score >= 0.86)) break;
      }

      const best = matches.sort((left, right) => right.score - left.score)[0];
      if (!best || best.score < 0.45) continue;
      seen.add(best.track.spotifyTrackId);
      candidates.push({
        ...best.track,
        searchQuery: pick,
        matchScore: best.score,
      });
      if (candidates.length >= maxCandidates) return candidates;
    }

    return candidates;
  }

  async createPlaylist(
    user: Doc<"users">,
    input: {
      name: string;
      description: string;
      tracks: RotationTrack[];
      isPublic?: boolean;
    },
  ): Promise<CreatedPlaylist> {
    const playlistDescription = spotifyDescriptionText(input.description).slice(0, 300);
    const playlist = await this.request<{
      id: string;
      name: string;
      uri: string;
      external_urls?: SpotifyExternalUrls;
    }>(user._id, "/me/playlists", {
      method: "POST",
      body: JSON.stringify({
        name: (spotifyPlainText(input.name) || "rotation").slice(0, 100),
        description: playlistDescription,
        public: input.isPublic ?? false,
      }),
    });

    const uris = input.tracks.map((track) => track.uri).filter(Boolean);
    for (let index = 0; index < uris.length; index += 100) {
      await this.request(user._id, `/playlists/${playlist.id}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(index, index + 100) }),
      });
    }

    await convex.mutation(api.spotify.saveCreatedTracks, {
      userId: user._id,
      tracks: input.tracks.map((track) => ({
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
        source: "created" as const,
        sources: track.sources,
        playlistIds: track.playlistIds,
        playlistCount: track.playlistCount,
        tasteWeight: track.tasteWeight,
      })),
      now: Date.now(),
    });

    await this.cachePlaylist(user, {
      id: playlist.id,
      name: playlist.name,
      description: playlistDescription,
      trackCount: input.tracks.length,
      url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
    });

    return {
      id: playlist.id,
      name: playlist.name,
      uri: playlist.uri,
      url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
    };
  }

  async getPlaylistTracks(
    userId: Id<"users">,
    playlistId: string,
    maxItems = 300,
  ) {
    const items = await this.paginate<{ item?: SpotifyTrack; track?: SpotifyTrack }>(
      userId,
      `/playlists/${playlistId}/items?limit=50&fields=items(item(id,name,artists(name),album(name),uri,external_urls,popularity,duration_ms,explicit,preview_url,is_local)),next`,
      maxItems,
    );
    return items
      .map((item) => mapTrack(item.item ?? item.track, "playlist", [playlistId]))
      .filter((track): track is RotationTrack => Boolean(track));
  }

  async replacePlaylistTracks(
    user: Doc<"users">,
    playlist: EditablePlaylist,
    tracks: RotationTrack[],
  ) {
    const uris = tracks.map((track) => track.uri).filter(Boolean);
    await this.request(user._id, `/playlists/${playlist.id}/tracks`, {
      method: "PUT",
      body: JSON.stringify({ uris: uris.slice(0, 100) }),
    });
    for (let index = 100; index < uris.length; index += 100) {
      await this.request(user._id, `/playlists/${playlist.id}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(index, index + 100) }),
      });
    }

    await convex.mutation(api.spotify.saveCreatedTracks, {
      userId: user._id,
      tracks: tracks.map((track) => ({
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
        source: "created" as const,
        sources: track.sources,
        playlistIds: [playlist.id],
        playlistCount: 1,
        tasteWeight: track.tasteWeight,
      })),
      now: Date.now(),
    });
    await this.cachePlaylist(user, {
      ...playlist,
      trackCount: tracks.length,
    });
  }

  async updatePlaylistDetails(
    user: Doc<"users">,
    playlist: EditablePlaylist,
    input: { name?: string | null; description?: string | null },
  ) {
    const nextName = input.name ? spotifyPlainText(input.name) : undefined;
    const nextDescription =
      input.description === undefined || input.description === null
        ? undefined
        : spotifyDescriptionText(input.description);
    if (!nextName && nextDescription === undefined) return playlist;

    await this.request(user._id, `/playlists/${playlist.id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...(nextName ? { name: nextName.slice(0, 100) } : {}),
        ...(nextDescription !== undefined
          ? { description: nextDescription.slice(0, 300) }
          : {}),
      }),
    }, true);

    const updated = {
      ...playlist,
      name: nextName ?? playlist.name,
      description: nextDescription ?? playlist.description,
    };
    await this.cachePlaylist(user, updated);
    return updated;
  }

  private async cachePlaylist(user: Doc<"users">, playlist: EditablePlaylist) {
    await convex.mutation(api.spotify.saveSnapshot, {
      userId: user._id,
      playlists: [
        {
          spotifyPlaylistId: playlist.id,
          name: playlist.name,
          description: playlist.description,
          ownerId: user.spotifyUserId,
          ownerName: user.spotifyDisplayName,
          trackCount: playlist.trackCount,
          public: false,
          externalUrl: playlist.url,
        },
      ],
      tracks: [],
      markSynced: false,
      now: Date.now(),
    });
  }

  async uploadPlaylistCover(
    userId: Id<"users">,
    playlistId: string,
    jpegBytes: Buffer,
  ) {
    await this.request<null>(
      userId,
      `/playlists/${playlistId}/images`,
      {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: jpegBytes.toString("base64"),
      },
      true,
    );
  }

  async currentPlayback(userId: Id<"users">) {
    return await this.request<{
      is_playing?: boolean;
      progress_ms?: number;
      item?: SpotifyTrack;
      context?: { uri?: string; type?: string; href?: string };
    }>(userId, "/me/player/currently-playing", {}, true);
  }

  private async getPlaylists(userId: Id<"users">) {
    return await this.paginate<SpotifyPlaylist>(
      userId,
      "/me/playlists?limit=50",
    );
  }

  private async getSavedTracks(userId: Id<"users">) {
    const first = await this.request<TotalPage<{ track?: SpotifyTrack }>>(
      userId,
      "/me/tracks?limit=50&offset=0",
    );
    const total = first.total ?? first.items.length;
    const offsets: number[] = [];
    for (let offset = 50; offset < total; offset += 50) {
      offsets.push(offset);
    }
    console.info("[spotify.sync] fetching saved track pages", {
      userId,
      total,
      pages: offsets.length + 1,
      concurrency: spotifyPageConcurrency,
    });

    const pages = await this.mapConcurrent(
      offsets,
      spotifyPageConcurrency,
      async (offset) =>
        await this.request<TotalPage<{ track?: SpotifyTrack }>>(
          userId,
          `/me/tracks?limit=50&offset=${offset}`,
        ),
    );
    const items = [first, ...pages].flatMap((page) => page.items ?? []);
    console.info("[spotify.sync] fetched saved tracks", {
      userId,
      total,
      items: items.length,
    });

    return items
      .map((item) => mapTrack(item.track, "saved"))
      .filter((track): track is RotationTrack => Boolean(track));
  }

  private async getTopTracks(userId: Id<"users">) {
    const all: RotationTrack[] = [];
    for (const range of ["short_term", "medium_term", "long_term"]) {
      const payload = await this.request<{ items?: SpotifyTrack[] }>(
        userId,
        `/me/top/tracks?limit=50&time_range=${range}`,
      );
      all.push(
        ...(payload.items ?? [])
          .map((track) => mapTrack(track, "top"))
          .filter((track): track is RotationTrack => Boolean(track)),
      );
    }
    return dedupeTracks(all);
  }

  private async getTracksFromPlaylists(
    userId: Id<"users">,
    playlists: SpotifyPlaylist[],
  ) {
    const playlistsWithTracks = playlists.filter(
      (playlist) => playlist.id && (playlist.tracks?.total ?? 0) > 0,
    );
    console.info("[spotify.sync] fetching owned playlist tracks", {
      userId,
      playlists: playlistsWithTracks.length,
      concurrency: spotifyPlaylistTrackConcurrency,
    });

    const trackGroups = await this.mapConcurrent(
      playlistsWithTracks,
      spotifyPlaylistTrackConcurrency,
      async (playlist) => {
        try {
          const items = await this.paginate<{ item?: SpotifyTrack; track?: SpotifyTrack }>(
            userId,
            `/playlists/${playlist.id}/items?limit=50&fields=items(item(id,name,artists(name),album(name),uri,external_urls,popularity,duration_ms,explicit,preview_url,is_local)),next`,
          );
          return items
          .map((item) => mapTrack(item.item ?? item.track, "playlist", [playlist.id]))
            .filter((track): track is RotationTrack => Boolean(track));
        } catch (caught) {
          console.warn("[spotify.sync] playlist tracks failed", {
            userId,
            playlistId: playlist.id,
            name: playlist.name,
            error: compactError(caught),
          });
          return [];
        }
      },
    );
    return trackGroups.flat();
  }

  private weightPlaylistsForTaste(
    playlists: SpotifyPlaylist[],
    spotifyUserId: string | undefined,
  ) {
    const lowSignalName =
      /\b(discover weekly|release radar|daily mix|radio|top songs|billboard|hot hits|viral|charts?)\b/i;
    const highSignalName =
      /\b(rotation|liked|favorites?|favourites?|best|vibes?|mood|gym|run|work|study|sleep|party|car|driv|summer|winter|fall|spring|sad|happy|chill|lock in)\b/i;
    const lowSignalOwner = /\b(spotify|topsify|filtr|digster)\b/i;

    const score = (playlist: SpotifyPlaylist) => {
      let value = 0;
      if (spotifyUserId && playlist.owner?.id === spotifyUserId) value += 12;
      if (highSignalName.test(playlist.name)) value += 5;
      if (playlist.description && highSignalName.test(playlist.description)) value += 2;
      if (lowSignalName.test(playlist.name)) value -= 8;
      if (playlist.owner?.display_name && lowSignalOwner.test(playlist.owner.display_name)) {
        value -= 6;
      }
      value += Math.min(playlist.tracks?.total ?? 0, 180) / 180;
      return value;
    };

    return [...playlists].sort((left, right) => score(right) - score(left));
  }

  private async paginate<T>(
    userId: Id<"users">,
    path: string,
    maxItems?: number,
  ) {
    const items: T[] = [];
    let next: string | null = path;
    while (next && (!maxItems || items.length < maxItems)) {
      const page: Page<T> = await this.request<Page<T>>(userId, next);
      items.push(...(page.items ?? []));
      next = page.next;
    }
    return maxItems ? items.slice(0, maxItems) : items;
  }

  private async mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
  ) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await fn(items[index] as T, index);
        }
      }),
    );
    return results;
  }

  private async request<T>(
    userId: Id<"users">,
    pathOrUrl: string,
    init: RequestInit = {},
    allowEmpty = false,
  ): Promise<T> {
    const token = await this.accessToken(userId);
    const method = (init.method ?? "GET").toUpperCase();
    const maxAttempts = method === "GET" ? 3 : 1;
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${apiBaseUrl}${pathOrUrl}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), spotifyRequestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...init.headers,
          },
        });
      } catch (caught) {
        clearTimeout(timeout);
        if (attempt < maxAttempts && method === "GET") {
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          continue;
        }
        throw caught;
      } finally {
        clearTimeout(timeout);
      }

      if (allowEmpty && response.status === 204) return null as T;
      if (response.ok) {
        if (allowEmpty) {
          const text = await response.text();
          return text ? (JSON.parse(text) as T) : (null as T);
        }
        return (await response.json()) as T;
      }

      const body = await response.text();
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (attempt < maxAttempts && retryable) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 800 * attempt;
        console.warn("[spotify.request_retry]", {
          userId,
          method,
          path: pathOrUrl.startsWith("http") ? new URL(pathOrUrl).pathname : pathOrUrl.split("?")[0],
          status: response.status,
          attempt,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw new Error(`spotify api ${response.status}: ${body}`);
    }

    throw new Error("spotify api request failed");
  }

  private async accessToken(userId: Id<"users">) {
    const tokenRecord = await convex.query(api.spotify.getTokens, { userId });
    if (!tokenRecord) throw new Error("spotify is not linked");

    if (tokenRecord.expiresAt - refreshSkewMs > Date.now()) {
      return await decryptToken(tokenRecord.accessTokenCiphertext);
    }

    const refreshToken = await decryptToken(tokenRecord.refreshTokenCiphertext);
    const refreshed = await this.refreshAccessToken(refreshToken);
    const nextRefreshToken = refreshed.refresh_token ?? refreshToken;
    await convex.mutation(api.spotify.saveTokens, {
      userId,
      accessTokenCiphertext: await encryptToken(refreshed.access_token),
      refreshTokenCiphertext: await encryptToken(nextRefreshToken),
      expiresAt: Date.now() + refreshed.expires_in * 1000,
      scope: refreshed.scope ?? tokenRecord.scope,
      tokenType: refreshed.token_type ?? tokenRecord.tokenType,
      now: Date.now(),
    });
    return refreshed.access_token;
  }

  private async refreshAccessToken(refreshToken: string) {
    const response = await fetch(`${accountsBaseUrl}/api/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${env.spotifyClientId}:${env.spotifyClientSecret}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok) {
      throw new Error(`spotify refresh failed: ${payload.error_description ?? payload.error}`);
    }
    if (!payload.access_token || !payload.expires_in) {
      throw new Error("spotify refresh response was missing required fields");
    }
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      token_type: payload.token_type,
      scope: payload.scope,
      expires_in: payload.expires_in,
    };
  }
}
