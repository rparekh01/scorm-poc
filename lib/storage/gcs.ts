import { AwsClient } from "aws4fetch";
import type { StorageAdapter, StoredObject } from "./types";

// GCS exposes an S3-compatible XML API at storage.googleapis.com, authenticated
// with HMAC keys. Uses only fetch + Web Crypto, so it runs on Node, Netlify and
// Cloudflare Workers alike.
export function createGcsAdapter(): StorageAdapter {
  const bucket = process.env.GCS_BUCKET;
  const accessKeyId = process.env.GCS_HMAC_ACCESS_KEY;
  const secretAccessKey = process.env.GCS_HMAC_SECRET;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("GCS_BUCKET, GCS_HMAC_ACCESS_KEY and GCS_HMAC_SECRET must be set");
  }
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });

  return {
    async getObject(key, range): Promise<StoredObject | null> {
      const url = `https://storage.googleapis.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const res = await client.fetch(url, { headers: range ? { Range: range } : {} });
      // A read-only key can get 403 instead of 404 for a missing object.
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok && res.status !== 206) throw new Error(`GCS responded ${res.status}`);
      return {
        body: res.body,
        status: res.status === 206 ? 206 : 200,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        contentLength: res.headers.get("content-length") ?? undefined,
        contentRange: res.headers.get("content-range") ?? undefined,
        etag: res.headers.get("etag") ?? undefined,
      };
    },
  };
}
