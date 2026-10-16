import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache: every route here is dynamic or static, nothing needs ISR.
export default defineCloudflareConfig();
