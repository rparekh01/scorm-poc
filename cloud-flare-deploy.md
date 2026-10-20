Deploying the SCORM POC to Cloudflare Workers (free plan, via GitHub)

Cloudflare builds and deploys the app from your GitHub repo. Every push to the connected branch redeploys it. The project is already set up with the OpenNext Cloudflare adapter: wrangler.jsonc, open-next.config.ts and .dev.vars.

Before you start
A free Cloudflare account (dash.cloudflare.com).
The app in a GitHub repo. .env.local and .dev.vars are git-ignored, so keep it that way: they must never be committed.
Your extracted bucket name, and the HMAC access key and secret from the GCP steps.

1. Configure

In wrangler.jsonc, replace YOUR_EXTRACTED_BUCKET with your extracted bucket name, then commit and push. The bucket name is not a secret. The access key and secret are, so they do not go in this file (step 3).

2. Connect the repo
   Cloudflare dashboard, Workers & Pages, Create, import your GitHub repository.
   Set the build command: npx opennextjs-cloudflare build and the deploy command: npx opennextjs-cloudflare deploy
   Save and deploy.

When the build finishes, the Worker's URL is https://scorm-poc.<your-subdomain>.workers.dev.

3. Set the secrets

In the dashboard: your Worker, Settings, Variables and Secrets, add these two as type Secret:

GCS_HMAC_ACCESS_KEY
GCS_HMAC_SECRET

Use the runtime variables for the running Worker, not the build-time variables under the build settings: the app reads these while serving requests, not while building. Paste the values when asked. Secrets are not shown again after saving. STORAGE_ADAPTER and GCS_BUCKET come from wrangler.jsonc.
