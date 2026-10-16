import { getStorage } from "@/lib/storage";

// Serves /scorm/{courseId}/manifest.json and /scorm/{courseId}/{version}/{file...}
// from the extracted bucket, so the course iframe shares the app's origin.
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;

  const segments = path.map((s) => { try { return decodeURIComponent(s); } catch { return null; } });
  if (
    segments.length < 2 ||
    segments.some((s) => s === null || s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0"))
  ) {
    return new Response("Not found", { status: 404 });
  }

  const key = (segments as string[]).join("/");
  const isManifest = segments.length === 2 && segments[1] === "manifest.json";

  let obj;
  try {
    obj = await getStorage().getObject(key, req.headers.get("range"));
  } catch (err) {
    console.error("storage error", err);
    return new Response("Storage error", { status: 502 });
  }
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": obj.contentType,
    "Accept-Ranges": "bytes",
    // manifest.json is the pointer to the current version: always revalidate.
    // Everything under {version}/ never changes at that URL: cache for a year.
    "Cache-Control": isManifest ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (obj.etag) headers.set("ETag", obj.etag);
  if (obj.contentLength) headers.set("Content-Length", obj.contentLength);
  if (obj.contentRange) headers.set("Content-Range", obj.contentRange);

  return new Response(obj.body, { status: obj.status, headers });
}
