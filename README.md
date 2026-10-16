# SCORM POC

Next.js app with a Start course button. It reads a course's `manifest.json`, creates a `scorm-again`
API object on the page, and opens the course in an iframe. Files are served by `app/scorm/[...path]/route.ts`
from the extracted bucket, so the course and the app share one origin.

## Run locally (no GCP)

    npm install
    npm run make-test-course      # writes local-data/demo-course/ and test-course/demo-course.zip
    cp .env.example .env.local    # STORAGE_ADAPTER=local
    npm run dev                   # open http://localhost:3000, press Start course

The test course reports "incomplete" on load and "completed" with score 100 when you press its button.
The calls appear under the iframe.

## Bigger test courses

`npm run make-test-courses` (needs `ffmpeg` and `zip`; takes about 5 minutes) builds two multi-step SCORM 1.2 courses
with a step menu, bookmarking, a quiz (pass mark 80%) and score and status reporting:

- `big-course`: 6 video steps (8.5, 9, 9.5, 10, 10, 10 minutes, 720p H.264, noisy so it does not compress) plus a quiz.
  About 500 MB unzipped, 490 MB zipped. Video steps have a "Mark as watched (test shortcut)" button.
- `small-course`: 6 text steps, each with an image, plus a quiz. About 20 MB.

Each run writes `test-course/{id}.zip` (upload to the zips bucket) and `local-data/{id}/` (pre-extracted).
The videos are synthetic test patterns, not real footage. Use course IDs `big-course` and `small-course` in the app.

## Run against GCS

1. Upload `test-course/demo-course.zip` to the zips bucket (name it `{courseId}.zip`).
2. The trigger and unzip function (yours to build) must produce the layout below in the extracted bucket.
3. Create a service account with read-only access to the extracted bucket and an HMAC key for it.
4. In `.env.local` set `STORAGE_ADAPTER=gcs`, `GCS_BUCKET`, `GCS_HMAC_ACCESS_KEY`, `GCS_HMAC_SECRET`.
5. Enter the course ID in the app and press Start course.

## What the unzip function must write

    {courseId}/{hash}/...            every file from the zip, same folder structure
    {courseId}/manifest.json         written last

    {
      "builderId": "{courseId}",
      "version": "<hash of the zip>",
      "launchPath": "content/index.html",
      "scormVersion": "1.2",
      "title": "...",
      "extractedAt": "2026-10-15T00:00:00Z"
    }

`launchPath` is the `href` of the launchable resource in `imsmanifest.xml`; `scormVersion` is `1.2` or
`2004` (from `schemaversion`). After writing the new manifest, delete the previous hash folder.

## Behavior

- `manifest.json`: `Cache-Control: no-cache`. Files under `{hash}/`: one year, immutable.
- Range requests are passed through (video seeking).
- Missing objects, and the 403 a read-only HMAC key can get for a missing object, both return 404.
- Anything that isn't a valid manifest shows "This course is not available."
- Handler and GCS adapter use only `fetch`, `Request`, `Response` (plus `aws4fetch`).
  The local adapter uses Node `fs` and is for testing only.

## Not verified

- The iframe finding the API in a real browser (no browser could be installed where this was built).
- The GCS adapter against a real bucket.
- Running the handler on Netlify and Cloudflare Workers.
