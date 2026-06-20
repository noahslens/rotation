import { webcrypto } from "node:crypto";
import { requireEnv } from "../config/env";
import { base64UrlDecode, base64UrlEncode } from "./base64url";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const key = async () => {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    encoder.encode(requireEnv("spotifyTokenEncryptionKey")),
  );
  return await webcrypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};

export const encryptToken = async (value: string) => {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    encoder.encode(value),
  );
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(ciphertext))}`;
};

export const decryptToken = async (value: string) => {
  const [version, iv, ciphertext] = value.split(":");
  if (version !== "v1" || !iv || !ciphertext) {
    throw new Error("unsupported encrypted token format");
  }
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(iv) },
    await key(),
    base64UrlDecode(ciphertext),
  );
  return decoder.decode(plaintext);
};
