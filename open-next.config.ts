import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default (in-memory) caches: pages here are per-user and not cached across
// requests. Add an R2/KV incremental cache later if public cached pages appear.
export default defineCloudflareConfig({});
