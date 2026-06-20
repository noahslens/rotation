import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";
import { env, requireEnv } from "../config/env";
import { decryptToken, encryptToken } from "../utils/tokenCrypto";

const accountsBaseUrl = "https://accounts.spotify.com";
const apiBaseUrl = "https://api.spotify.com/v1";
const refreshSkewMs = 90_000;

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
  playlistIds?: string[];
};

export type CandidateTrack = RotationTrack & {
  searchQuery?: string;
};

export type CreatedPlaylist = {
  id: string;
  name: string;
  url: string;
  uri: string;
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
  owner?: { display_name?: string };
  tracks?: { total?: number };
  snapshot_id?: string;
  public?: boolean;
  external_urls?: SpotifyExternalUrls;
  uri?: string;
};

type Page<T> = {
  items: T[];
  next: string | null;
};

const compactDescription = (value: string | null | undefined) => {
  if (!value) return undefined;
  const withoutTags = value.replace(/<[^>]+>/g, "").trim();
  return withoutTags || undefined;
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
    playlistIds,
  };
};

const dedupeTracks = <T extends RotationTrack>(tracks: T[]) => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.spotifyTrackId)) return false;
    seen.add(track.spotifyTrackId);
    return true;
  });
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

  async syncUserLibrary(userId: Id<"users">) {
    const [playlists, savedTracks, topTracks] = await Promise.all([
      this.getPlaylists(userId),
      this.getSavedTracks(userId),
      this.getTopTracks(userId),
    ]);

    const playlistTracks = await this.getTracksFromPlaylists(
      userId,
      playlists.slice(0, 12),
    );
    const tracks = dedupeTracks([...savedTracks, ...topTracks, ...playlistTracks]);

    await convex.mutation(api.spotify.saveSnapshot, {
      userId,
      playlists: playlists.map((playlist) => ({
        spotifyPlaylistId: playlist.id,
        name: playlist.name,
        description: compactDescription(playlist.description),
        ownerName: playlist.owner?.display_name,
        trackCount: playlist.tracks?.total ?? 0,
        snapshotId: playlist.snapshot_id,
        public: playlist.public,
        externalUrl: playlist.external_urls?.spotify,
      })),
      tracks,
      now: Date.now(),
    });

    return { playlists: playlists.length, tracks: tracks.length };
  }

  async searchTracks(
    userId: Id<"users">,
    queries: string[],
    knownTrackIds: Set<string>,
    maxCandidates = 180,
  ) {
    const candidates: CandidateTrack[] = [];
    const seen = new Set(knownTrackIds);

    for (const query of queries.slice(0, 28)) {
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

  async createPlaylist(
    user: Doc<"users">,
    input: {
      name: string;
      description: string;
      tracks: RotationTrack[];
      isPublic?: boolean;
    },
  ): Promise<CreatedPlaylist> {
    const playlist = await this.request<{
      id: string;
      name: string;
      uri: string;
      external_urls?: SpotifyExternalUrls;
    }>(user._id, "/me/playlists", {
      method: "POST",
      body: JSON.stringify({
        name: input.name.slice(0, 100),
        description: input.description.slice(0, 300),
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
        playlistIds: track.playlistIds,
      })),
      now: Date.now(),
    });

    return {
      id: playlist.id,
      name: playlist.name,
      uri: playlist.uri,
      url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
    };
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
      120,
    );
  }

  private async getSavedTracks(userId: Id<"users">) {
    const items = await this.paginate<{ track?: SpotifyTrack }>(
      userId,
      "/me/tracks?limit=50",
      200,
    );
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
    const tracks: RotationTrack[] = [];
    for (const playlist of playlists) {
      const total = playlist.tracks?.total ?? 0;
      if (!playlist.id || total === 0) continue;
      const items = await this.paginate<{ item?: SpotifyTrack; track?: SpotifyTrack }>(
        userId,
        `/playlists/${playlist.id}/items?limit=50&fields=items(item(id,name,artists(name),album(name),uri,external_urls,popularity,duration_ms,explicit,preview_url,is_local)),next`,
        100,
      );
      tracks.push(
        ...items
          .map((item) => mapTrack(item.item ?? item.track, "playlist", [playlist.id]))
          .filter((track): track is RotationTrack => Boolean(track)),
      );
    }
    return tracks;
  }

  private async paginate<T>(
    userId: Id<"users">,
    path: string,
    maxItems: number,
  ) {
    const items: T[] = [];
    let next: string | null = path;
    while (next && items.length < maxItems) {
      const page: Page<T> = await this.request<Page<T>>(userId, next);
      items.push(...(page.items ?? []));
      next = page.next;
    }
    return items.slice(0, maxItems);
  }

  private async request<T>(
    userId: Id<"users">,
    pathOrUrl: string,
    init: RequestInit = {},
    allowEmpty = false,
  ): Promise<T> {
    const token = await this.accessToken(userId);
    const response = await fetch(
      pathOrUrl.startsWith("http") ? pathOrUrl : `${apiBaseUrl}${pathOrUrl}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init.headers,
        },
      },
    );

    if (allowEmpty && response.status === 204) return null as T;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`spotify api ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
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
