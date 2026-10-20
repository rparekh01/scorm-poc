# SCORM POC: GCP setup, one step at a time

One private bucket holds the **already-unzipped** courses. You unzip on your own computer and upload the result (see `scripts/README.md`). There is no zips bucket and no Cloud Function.

Placeholders used below. Replace them with your own values.

| Placeholder       | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `YOUR_PROJECT_ID` | GCP project ID (project picker at the top of the console, ID column; or `gcloud config get-value project`) |
| `YOUR_REGION`     | Region you choose, e.g. `us-east1`                                                                         |
| `YOUR_SUFFIX`     | Short lowercase string that makes the bucket name unique (bucket names are global)                         |
| `YOUR_EMAIL`      | Your Google account email                                                                                  |

All commands run in **Cloud Shell** (the `>_` icon at the top right of the GCP console). Run them one at a time and check each before moving on.

---

## 1. Set variables

```bash
PROJECT="YOUR_PROJECT_ID"
REGION="YOUR_REGION"
SUFFIX="YOUR_SUFFIX"
BUCKET="scorm-extracted-$SUFFIX"
echo "$PROJECT" "$REGION" "$BUCKET"
```

All three values should print. **These variables disappear if Cloud Shell restarts, so paste this block again in a new session** before running later steps.

## 2. Select the project and enable the Storage API

```bash
gcloud config set project "$PROJECT"
gcloud services enable storage.googleapis.com
```

## 3. Create the bucket

```bash
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
```

It is private: nothing in it is reachable without credentials. "Already exists" means this step is done.

Layout inside the bucket (created later by your uploads):

```
<course-id>/manifest.json
<course-id>/<hash>/...course files...
```

## 4. Create the read-only service account for the app

```bash
gcloud iam service-accounts create scorm-reader --project="$PROJECT" --display-name="SCORM reader"
SA="scorm-reader@$PROJECT.iam.gserviceaccount.com"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectViewer"
```

"Already exists" on the first command is fine. This account can only read this bucket. It cannot write or delete, so the app can never change your courses.

## 5. Allow key creation (org policy), only if step 6 is blocked

Skip this step unless step 6 fails with `Request violates constraint 'constraints/iam.disableServiceAccountKeyCreation'`. That is a default org policy blocking service account keys. Turn it off for this project only:

```bash
gcloud organizations list
```

Copy the organization ID, then:

```bash
ORG_ID=<the ID>
gcloud organizations add-iam-policy-binding $ORG_ID \
  --member="user:YOUR_EMAIL" --role="roles/orgpolicy.policyAdmin"
```

```bash
gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation \
  --project="$PROJECT"
```

Wait about a minute: policy changes take a short while to spread. If step 6 still reports the constraint, wait and retry.

## 6. Create the HMAC key

```bash
gcloud storage hmac create "scorm-reader@$PROJECT.iam.gserviceaccount.com"
```

It prints an `accessId` and a `secret`. **The secret is shown once.** Put both in `.env.local` in the Next.js app:

```
STORAGE_ADAPTER=gcs
GCS_BUCKET=scorm-extracted-YOUR_SUFFIX
GCS_HMAC_ACCESS_KEY=<accessId>
GCS_HMAC_SECRET=<secret>
```

Keep `.env.local` out of git. For the Cloudflare deploy, set the same four values as runtime variables, with the secret as type **Secret**.

Optional cleanup afterward (existing keys keep working):

```bash
gcloud resource-manager org-policies enable-enforce iam.disableServiceAccountKeyCreation --project="$PROJECT"
```

## 7. Upload your courses

Unzip on your computer and upload the extracted folders. The steps are in `scripts/README.md`:

1. `node scripts/unzip-local.mjs` unzips each zip into `<course-id>/<hash>/` plus `manifest.json`.
2. The upload loop copies each course (files first, `manifest.json` last).
3. The verify loop confirms the bucket matches your local folder.

To check that something landed:

```bash
gcloud storage ls "gs://$BUCKET/"
gcloud storage cat "gs://$BUCKET/small-course/manifest.json"
```

The course ID is the zip's file name without `.zip`, and it must equal the folder name in the bucket.

---

## Quick troubleshooting

| Symptom                                               | Cause / fix                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `already exists` on the bucket or service account     | Already created. Skip that command.                                                                     |
| `iam.disableServiceAccountKeyCreation` on HMAC create | Step 5.                                                                                                 |
| Variables empty after reopening Cloud Shell           | Re-run the step 1 block.                                                                                |
| `Unrecognized scheme ""` on an upload                 | `$BUCKET` or the local folder variable is empty. Check with `echo`.                                     |
| App shows "This course is not available."             | Check bucket name and key in `.env.local`, and that the course ID equals the folder name in the bucket. |
| Permission error when the app reads                   | The `scorm-reader` account needs `roles/storage.objectViewer` on this bucket (step 4).                  |
