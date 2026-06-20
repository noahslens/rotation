import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp, { type Sharp } from "sharp";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api, convex } from "../state/convex";

const spotifyCoverMaxBytes = 256 * 1024;
const execFileAsync = promisify(execFile);

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

const userPhotoSharp = (bytes: Buffer) =>
  sharp(bytes, {
    limitInputPixels: 100_000_000,
    unlimited: true,
  });

const convertWithSips = async (bytes: Buffer) => {
  const dir = await mkdtemp(join(tmpdir(), "rotation-photo-"));
  const inputPath = join(dir, "input.heic");
  const outputPath = join(dir, "output.jpg");
  try {
    await writeFile(inputPath, bytes);
    await execFileAsync("sips", ["-s", "format", "jpeg", inputPath, "--out", outputPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const withUserPhotoFallback = async (
  bytes: Buffer,
  render: (image: Sharp) => Promise<Buffer>,
) => {
  try {
    return await render(userPhotoSharp(bytes));
  } catch (caught) {
    if (process.platform !== "darwin") throw caught;
    const jpegBytes = await convertWithSips(bytes);
    return await render(sharp(jpegBytes));
  }
};

const normalizedUserPhoto = async (bytes: Buffer) => {
  try {
    await userPhotoSharp(bytes)
      .rotate()
      .resize(16, 16, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
    return { bytes, usePlainSharp: false };
  } catch (caught) {
    if (process.platform !== "darwin") throw caught;
    return { bytes: await convertWithSips(bytes), usePlainSharp: true };
  }
};

const normalizedSharp = (input: { bytes: Buffer; usePlainSharp: boolean }) =>
  input.usePlainSharp ? sharp(input.bytes) : userPhotoSharp(input.bytes);

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
  await withUserPhotoFallback(bytes, async (image) =>
    await image
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer(),
  );

export const spotifyCoverJpeg = async (bytes: Buffer) => {
  const input = await normalizedUserPhoto(bytes);
  for (const size of [640, 512, 384, 300]) {
    for (const quality of [88, 80, 72, 64, 56, 48]) {
      const output = await normalizedSharp(input)
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
