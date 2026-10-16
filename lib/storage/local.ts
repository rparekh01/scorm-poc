import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { StorageAdapter, StoredObject } from "./types";

// Test-only adapter: serves extracted courses from ./local-data, laid out exactly
// like the extracted bucket ({id}/manifest.json, {id}/{hash}/...).
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2",
};

export function createLocalAdapter(): StorageAdapter {
  const root = path.resolve(process.cwd(), "local-data");
  return {
    async getObject(key, range): Promise<StoredObject | null> {
      const file = path.resolve(root, key);
      if (!file.startsWith(root + path.sep)) return null;
      let info;
      try { info = await stat(file); } catch { return null; }
      if (!info.isFile()) return null;

      const contentType = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
      const m = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        let start = m[1] ? parseInt(m[1], 10) : Math.max(info.size - parseInt(m[2], 10), 0);
        let end = m[1] && m[2] ? parseInt(m[2], 10) : info.size - 1;
        end = Math.min(end, info.size - 1);
        if (start <= end) {
          return {
            body: Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>,
            status: 206, contentType, etag,
            contentLength: String(end - start + 1),
            contentRange: `bytes ${start}-${end}/${info.size}`,
          };
        }
      }
      return {
        body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
        status: 200, contentType, etag, contentLength: String(info.size),
      };
    },
  };
}
