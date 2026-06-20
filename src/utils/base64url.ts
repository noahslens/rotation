export const base64UrlEncode = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const base64UrlDecode = (value: string) => {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return new Uint8Array(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
};
