#!/usr/bin/env bash
# One-shot GCP setup for the SCORM unzip pipeline. Safe to re-run.
# Run from the gcp/ folder (the one containing index.js) in Cloud Shell.
set -euo pipefail

# ---- edit these three ----
PROJECT="YOUR_PROJECT_ID"
REGION="YOUR_REGION"        # e.g. us-east1. Buckets and function share it.
SUFFIX="YOUR_SUFFIX"        # short, lowercase, makes bucket names unique
# --------------------------

ZIPS="scorm-zips-$SUFFIX"
OUT="scorm-extracted-$SUFFIX"

[ -f index.js ] || { echo "Run this from the gcp/ folder (index.js not found)"; exit 1; }
case "$PROJECT$REGION$SUFFIX" in *YOUR_*) echo "Edit PROJECT, REGION and SUFFIX at the top first"; exit 1;; esac

gcloud config set project "$PROJECT"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

echo "== 1/5 Enable APIs"
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com eventarc.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com

echo "== 2/5 Buckets (private, skipped if they exist)"
for B in "$ZIPS" "$OUT"; do
  if gcloud storage buckets describe "gs://$B" >/dev/null 2>&1; then
    echo "  gs://$B exists"
  else
    gcloud storage buckets create "gs://$B" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention
  fi
done

echo "== 3/5 Cloud Storage service account -> Pub/Sub publisher"
# Google creates this account lazily; asking the API for it forces it to exist.
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://storage.googleapis.com/storage/v1/projects/$PROJECT/serviceAccount" >/dev/null
GCS_SA="service-$PROJECT_NUMBER@gs-project-accounts.iam.gserviceaccount.com"
ok=0
for i in $(seq 1 10); do
  if gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$GCS_SA" --role="roles/pubsub.publisher" >/dev/null 2>&1; then
    ok=1; break
  fi
  echo "  waiting for the storage service account to appear ($i/10)..."; sleep 15
done
[ "$ok" = 1 ] || { echo "Could not grant pubsub.publisher to $GCS_SA. Wait a few minutes and re-run."; exit 1; }

echo "== 4/5 Roles for the function's account"
for ROLE in roles/eventarc.eventReceiver roles/run.invoker roles/storage.objectAdmin roles/cloudbuild.builds.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" --role="$ROLE" >/dev/null
done

echo "== 5/5 Deploy function + trigger on gs://$ZIPS"
gcloud functions deploy scorm-unzip \
  --gen2 --runtime=nodejs22 --region="$REGION" --source=. --entry-point=unzipCourse \
  --trigger-bucket="$ZIPS" \
  --memory=4GiB --timeout=540s --max-instances=3 \
  --set-env-vars="EXTRACTED_BUCKET=$OUT" --quiet

echo "Done. Upload a zip:  gcloud storage cp small-course.zip gs://$ZIPS/"
echo "Check output:        gcloud storage ls -r gs://$OUT/"
