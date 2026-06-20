import sharp from "sharp";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";

const spotifyCoverMaxBytes = 256 * 1024;

export type SavedUserPhoto = Doc<"userPhotos"> & {
  url: string | null;
};

export type CoverPhotoCandidate = {
  id: string;
  photoId: Id<"userPhotos">;
  name: string;
  mimeType: string;
  uploadedAt: number;
  originalBytes: Buffer;
  modelBytes: Buffer;
};

export const isImageMime = (mimeType: string | undefined) =>
  Boolean(mimeType?.toLowerCase().startsWith("image/"));

const safePhotoName = (name: string | undefined, fallback = "photo") =>
  (name?.trim() || fallback).slice(0, 120);

export const saveUserPhoto = async (input: {
  userId: Id<"users">;
  bytes: Buffer;
  mimeType: string;
  name?: string;
  size?: number;
  sourceMessageId?: string;
}) => {
  const uploadUrl = await convex.mutation(api.photos.generateUploadUrl, {});
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": input.mimeType },
    body: input.bytes,
  });

  if (!upload.ok) {
    throw new Error(`convex photo upload failed ${upload.status}: ${await upload.text()}`);
  }

  const payload = (await upload.json()) as { storageId?: string };
  if (!payload.storageId) throw new Error("convex photo upload missing storageId");

  return await convex.mutation(api.photos.savePhoto, {
    userId: input.userId,
    storageId: payload.storageId as Id<"_storage">,
    name: safePhotoName(input.name),
    mimeType: input.mimeType,
    size: input.size ?? input.bytes.byteLength,
    sourceMessageId: input.sourceMessageId,
    now: Date.now(),
  });
};

export const listUserPhotos = async (userId: Id<"users">) =>
  (await convex.query(api.photos.listForUser, { userId })) as SavedUserPhoto[];

export const fetchPhotoBytes = async (photo: SavedUserPhoto) => {
  if (!photo.url) throw new Error(`missing storage url for photo ${photo._id}`);
  const response = await fetch(photo.url);
  if (!response.ok) {
    throw new Error(`photo fetch failed ${response.status}: ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

export const modelPhotoJpeg = async (bytes: Buffer) =>
  await sharp(bytes)
    .rotate()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

export const spotifyCoverJpeg = async (bytes: Buffer) => {
  for (const size of [640, 512, 384, 300]) {
    for (const quality of [88, 80, 72, 64, 56, 48]) {
      const output = await sharp(bytes)
        .rotate()
        .resize(size, size, { fit: "cover" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (output.byteLength <= spotifyCoverMaxBytes) return output;
    }
  }

  throw new Error("could not compress playlist cover under spotify limit");
};

export const markPhotoUsed = async (
  photoId: Id<"userPhotos">,
  playlistId: string,
) => {
  await convex.mutation(api.photos.markUsed, {
    photoId,
    playlistId,
    now: Date.now(),
  });
};
