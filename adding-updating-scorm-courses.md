# Adding and updating SCORM courses

How a course gets from a `.zip` to something the app can launch. Everything happens on your own computer. Nothing runs in the cloud except the bucket.

```
course.zip  ->  unzip locally  ->  upload to bucket  ->  verify  ->  test in app
```

## How it is laid out

Local output and bucket have the same shape:

```
<course-id>/
  manifest.json        <- the app reads this first (launch file, SCORM version, title, version)
  <hash>/              <- the course files; hash = first 12 characters of the zip's SHA-256
    imsmanifest.xml
    ...
```

- **Course ID** is the zip's file name without `.zip` (`small-course.zip` becomes `small-course`). Keep it lowercase, with no spaces. It appears in the course URL.
- **Hash folder** changes whenever the zip changes. The same zip always gives the same hash, so re-running on an unchanged zip does nothing.
- **manifest.json is uploaded last.** The app reads it first and then loads files from the hash folder it names, so it must never point at a folder that is only half uploaded.

## Before you start

- Node and the app's dependencies: `npm install` in the app folder.
- Google Cloud CLI installed and signed in: `gcloud auth login`, then `gcloud config set project YOUR_PROJECT_ID`.
- The extracted bucket already exists (`scorm-extracted-YOUR_SUFFIX`) and you can write to it.

## 1. Put the zips in one folder

```
~/Documents/scorm-zips/
  small-course.zip
  safety-training.zip
```

## 2. Unzip locally

From the app folder:

```bash
node scripts/unzip-local.mjs ~/Documents/scorm-zips --out ~/Documents/scorm-extracted
```

You can also pass a single zip instead of a folder. For each zip the script:
1. Computes the hash and skips the course if its manifest already has that version.
2. Extracts into a `.tmp-<hash>` folder and renames it when complete, so a failure never leaves a half-extracted version. (A leftover `.tmp-*` folder means a run failed, so delete it and run again.)
3. Reads `imsmanifest.xml` to find the launch file, SCORM version (1.2 or 2004) and title.
4. Writes `manifest.json`, then removes the previous version folder locally.

Look at the result before uploading:

```bash
ls ~/Documents/scorm-extracted
cat ~/Documents/scorm-extracted/small-course/manifest.json
```

The app launches only the first launchable item, so it supports single-SCO courses. A multi-SCO course will load but only its first item will launch.

## 3. Set the variables

```bash
SRC=~/Documents/scorm-extracted
BUCKET=gs://YOUR_EXTRACTED_BUCKET
echo "$SRC" "$BUCKET"        # both must print a value; an empty one causes "Unrecognized scheme"
```

Variables are lost when you close the terminal, so set them again in a new window.

## 4. Upload

Files first (manifest excluded), then the manifest, per course. The manifest only uploads if the files uploaded without error.

```bash
EX='^manifest\.json$,.*\.DS_Store$,.*\.tmp-.*'

for d in "$SRC"/*/; do
  id=$(basename "$d"); d=${d%/}
  gcloud storage rsync --recursive "$d" "$BUCKET/$id" --exclude="$EX" &&
  gcloud storage cp "$d/manifest.json" "$BUCKET/$id/manifest.json" ||
  echo "FAILED: $id"
done
```

Nothing is deleted by this step. For a single course, run the two `gcloud` commands with that course's folder.

## 5. Verify

Re-runs the upload as a dry run, comparing checksums, then compares the manifest:

```bash
for d in "$SRC"/*/; do
  id=$(basename "$d"); d=${d%/}
  echo "== $id"
  gcloud storage rsync --recursive --dry-run --checksums-only \
    --delete-unmatched-destination-objects "$d" "$BUCKET/$id" --exclude="$EX"
  diff <(gcloud storage cat "$BUCKET/$id/manifest.json") "$d/manifest.json" \
    && echo "manifest OK"
done
```

For each course you want to see `Completed files 0 | 0B` and `manifest OK`, with no `Would copy`, `Would remove` or `ERROR` lines. Count the `manifest OK` lines against the number of courses (`ls "$SRC" | wc -l`).

- `Would copy` means a file is missing or different in the bucket. Run step 4 again for that course.
- `Would remove` means the bucket has a file you don't have locally, usually an old version. See "Replacing a course".

## 6. Test in the app

Open a couple of courses, including your largest one and one with video, and confirm they launch and play.

## Replacing a course with a new version

1. Put the new zip in the zips folder with the **same file name**, then run step 2. This creates a new hash folder and removes the old one locally.
2. Run step 4. This uploads the new hash folder and then overwrites `manifest.json`. From that moment the app serves the new version.
3. Optional cleanup of the old version in the bucket. Run this **after** step 4 has finished, never before, since learners may still be using the old files:

```bash
gcloud storage rsync --recursive --delete-unmatched-destination-objects \
  "$SRC/small-course" "$BUCKET/small-course" --exclude="$EX"
```

Add `--dry-run` first to see what it would delete. The `--exclude` also protects `manifest.json` from being deleted. Skipping this step is harmless, since old versions only cost a little storage and step 5 will list them as `Would remove`.

## Removing a course

Delete the manifest first so the app stops offering it, then the files:

```bash
gcloud storage rm "$BUCKET/small-course/manifest.json"
gcloud storage rm --recursive "$BUCKET/small-course"
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Unrecognized scheme ""` | `$BUCKET` or `$SRC` is empty. Run step 3 and check with `echo`. |
| Course shows "This course is not available." | Wrong course ID, no `manifest.json` in the bucket, or wrong bucket in the app's settings. |
| `Would remove` in the verify output | Old hash folder or stray files in the bucket. See "Replacing a course". |
| `Would copy` in the verify output | Incomplete upload. Run step 4 again for that course. |
| `.tmp-*` folder in the extracted folder | An unzip run failed. Delete it and run step 2 again. |
| `FAILED: <id>` in step 4 | Read the error just above it (permissions, network, bad path) and re-run for that course. |
| A multi-SCO course only plays its first lesson | Expected. The app launches only the first launchable item. |
