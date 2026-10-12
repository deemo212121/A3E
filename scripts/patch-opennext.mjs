#!/usr/bin/env node
/**
 * Build-time fix for @opennextjs/cloudflare 1.20.10 with Next.js 16.4:
 * the adapter inlines Next's JSON manifests into the worker (workerd cannot
 * read files at runtime), but its list does not include `preview-props.json`,
 * which Next 16.4 loads on every request. Without it every page returns 500
 * ("Unexpected loadManifest(/.next/server/preview-props.json) call!").
 *
 * This adds the file to the adapter's list. Idempotent; fails loudly if the
 * adapter changed (then check whether a newer version already fixes it and
 * remove this script).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = join(process.cwd(), "node_modules", "@opennextjs", "cloudflare");
const file = join(pkgDir, "dist/cli/build/patches/plugins/load-manifest.js");
const from = "{*-manifest,required-server-files,prefetch-hints}.json";
const to = "{*-manifest,required-server-files,prefetch-hints,preview-props}.json";

const src = readFileSync(file, "utf8");
if (src.includes(to)) {
  console.log("patch-opennext: already applied");
} else if (src.includes(from)) {
  writeFileSync(file, src.replace(from, to));
  console.log("patch-opennext: added preview-props.json to the inlined manifests");
} else {
  console.error(
    `patch-opennext: pattern not found in ${file}; the adapter changed — review this patch.`,
  );
  process.exit(1);
}
