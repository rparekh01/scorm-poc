# Adding and replacing SCORM courses

How a course gets from a `.zip` to something the app can launch. Everything runs on your own computer with one script. The bucket is the only thing in the cloud.

```
course.zip  ->  dry run (unzip locally, see the plan)  ->  --apply (upload, check)  ->  enter the ID in Builder
```

## How it is laid out

Local output and bucket have the same shape:

```
<id>/
  manifest.json      <- { "version": "<upload time>", "courseTitle": "<title>" }, uploaded last
  imsmanifest.xml    <- the course's own files, straight from the zip
  story.html
  ...
```

- **The bucket is the source of truth for IDs.** A course's ID is its folder name, a whole number (`1`, `2`, ... `37`). Zip file names don't matter and don't need renaming.
- **`version`** is the time of the upload. The app saves it with each learner's progress. When it changes, learners with older progress start the course over.
- **`courseTitle`** is read from the course package. It is a label for people browsing the bucket. The app doesn't depend on it.
- **`manifest.json` is uploaded last.** Its presence means the folder is complete. A course with no manifest is treated as not available.

## Before you start

- Node and the app's dependencies: `npm install` in the app folder.
- Google Cloud CLI installed and signed in: `gcloud auth login`, then `gcloud config set project YOUR_PROJECT_ID`.
- The bucket exists and you can write to it.
- **Create IDs in dev only**, then promote by copying folders to the other environments. If you create IDs separately in each environment, the same number can end up meaning different courses.

## Two modes

One of them is required. With neither, the script stops and prints its usage.

| Mode      | Use it for                                              | Needs                      |
| --------- | ------------------------------------------------------- | -------------------------- |
| `upload`  | A new course that is not in the bucket yet              | a zip, or a folder of zips |
| `replace` | A new version of a course that is already in the bucket | one zip and `--id <N>`     |

`upload` gives each zip the next free ID: the highest numbered folder in the bucket, plus one. A folder of zips is numbered in file-name order, so the first batch becomes 1 to n. `replace` keeps the course's existing ID.

## 1. Dry run (the default)

```bash
BUCKET=gs://YOUR_BUCKET

# new courses: one zip, or a whole folder of zips
node scripts/unzip-local.mjs upload ~/Documents/scorm-zips --bucket $BUCKET --out ~/Documents/scorm-extracted

# a new version of course 17
node scripts/unzip-local.mjs replace ~/Documents/scorm-zips/"Vendor Safety v2.zip" --id 17 --bucket $BUCKET --out ~/Documents/scorm-extracted
```

The dry run unzips into `--out` and prints a plan. **Nothing is uploaded or deleted.** The bucket is only read (the folder list and existing manifests). Look at the plan:

```
  1   "Fire Safety"  SCORM 1.2, launch story.html
      3 files, 616 B   from Fire Safety.zip
      unzipped to /.../out/1
```

Check that each ID, title and zip name belongs together, and look at the unzipped folder if you want to. It also writes `summary-<time>.csv` in the output folder with ID, title and zip name. **Keep it for the first batch**: you'll use it to match IDs to Builder entries.

Warnings you may see:

- `course N already has this title`: for `upload`. This may be a new version of an existing course. If so, run `replace --id N` instead.
- `the bucket has "X" as course N, but this zip is "Y"`: for `replace`. Check that you picked the right zip.

Running the same command again gives every zip the same ID as before, so you can repeat a dry run freely.

## 2. Upload

Run the same command again with `--apply` added:

```bash
node scripts/unzip-local.mjs upload ~/Documents/scorm-zips --bucket $BUCKET --out ~/Documents/scorm-extracted --apply
```

For each course the script:

1. (`replace` only) deletes the old folder in the bucket. The course is unavailable until step 3 finishes, so do it when nobody is taking the course.
2. Uploads the course files.
3. Uploads `manifest.json`, last. Now the course is available.
4. Checks the upload: the bucket must match your local folder, and the manifests must be identical.

It ends with a summary of every course, and exits with an error if any failed. A failed course doesn't stop the others.

For `upload`, the script refuses an ID that already has a finished course in the bucket, and tells you to use `replace` instead.

## 3. Tell Builder the ID

For new courses, enter each assigned ID in that course's Builder content (the course ID field) and publish. Use the `summary-*.csv` file to match IDs to titles.

## 4. Test in the app

Open a couple of courses, including your largest one and one with video, and confirm they launch and play.

## Removing a course

Delete the manifest first so the app stops offering it, then the files:

```bash
gcloud storage rm "$BUCKET/17/manifest.json"
gcloud storage rm --recursive "$BUCKET/17/"
```

**Don't reuse the ID.** Learners' saved progress and enrollments for it still exist. If the highest-numbered course is deleted, the next `upload` would give the same number to a different course, so keep that in mind before deleting the newest course.

## If you want to run the upload by hand

`--apply` does the equivalent of this for one course (ID 17, folder `$SRC/17`):

```bash
EX='^manifest\.json$,.*\.DS_Store$'
gcloud storage rm --recursive "$BUCKET/17/"                                  # replace only
gcloud storage rsync --recursive "$SRC/17" "$BUCKET/17" --exclude="$EX"       # files
gcloud storage cp "$SRC/17/manifest.json" "$BUCKET/17/manifest.json"          # manifest last

# check: expect "Completed files 0 | 0B" and no "Would copy" / "Would remove" lines
gcloud storage rsync --recursive --dry-run --checksums-only \
  --delete-unmatched-destination-objects "$SRC/17" "$BUCKET/17" --exclude="$EX"
diff <(gcloud storage cat "$BUCKET/17/manifest.json") "$SRC/17/manifest.json" && echo "manifest OK"
```

## Troubleshooting

| Symptom                                           | Cause / fix                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The usage text appears and nothing runs           | The mode (`upload` or `replace`) is missing or misspelled, or a required option is missing. Read the line starting with `Error:`. |
| `could not read gs://...`                         | The bucket name is wrong, or you aren't signed in with access to it. Check `--bucket` and run `gcloud auth login`.                |
| `course N is not in the bucket`                   | `replace` was given an ID that doesn't exist. Check the ID, or use `upload` for a new course.                                     |
| `ID N is already a finished course in the bucket` | You ran `upload` for a zip that was uploaded earlier. Use `replace <zip> --id N`.                                                 |
| `check failed` after an upload                    | The bucket doesn't match your local folder. Run the same command with `--apply` again.                                            |
| `FAILED ... may be incomplete` on a replace       | The old folder was deleted and the new upload didn't finish. Run the same command with `--apply` again to finish it.              |
| Course shows "This course is not available."      | Wrong ID in Builder, no `manifest.json` in the bucket, or the upload didn't finish.                                               |
| `imsmanifest.xml not found at zip root`           | The zip has an extra folder around the course files, or isn't a SCORM package. Re-zip so `imsmanifest.xml` is at the top.         |
| A multi-SCO course only plays its first lesson    | Expected. The app launches only the first launchable item.                                                                        |

## What has and hasn't been tested

The script was tested end to end against a stand-in for `gcloud` that works on a local folder: dry runs, `--apply`, replace, ID assignment, failure handling and the post-upload check. It has **not** been run against a real bucket, so run it first on a throwaway course in dev, and run the manual check above if the script's check ever looks wrong.
