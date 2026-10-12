# Deploying to Cloudflare (Workers, from GitHub)

The app runs on **Cloudflare Workers** using the OpenNext adapter (`@opennextjs/cloudflare`). Cloudflare builds and deploys it from the GitHub repository on each push.

**Status (2026-10-12): BETA.**
- Staff two-step verification (MFA) is **off**. To turn it back on, see the end of this guide.
- Use **sample/test data only** until the system is verified.

## 1. One-time setup in the Cloudflare dashboard

1. **Workers & Pages → Create → Import a repository**, then pick this GitHub repo and the `main` branch.
2. **Build settings:**

   | Setting | Value |
   |---|---|
   | Build command | `npm run cf:build` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` (repository root) |

   - The Node version comes from `.node-version` (24).
   - The worker name comes from `wrangler.jsonc` (`a3e-accounting`). The name in the dashboard must match it.
3. **Build variables** (Settings → Build → Variables). These are baked into the browser code at build time:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the **publishable** (anon) key, never the secret key |

4. **Runtime variables** (Settings → Variables and Secrets):

   | Name | Type | Value |
   |---|---|---|
   | `APP_BASE_URL` | Text | the site URL, e.g. `https://a3e-accounting.<your-subdomain>.workers.dev` |
   | `SUPABASE_SECRET_KEY` | **Secret** | the Supabase secret key (needed for invitations and document uploads) |
   | `NEXT_PUBLIC_SUPABASE_URL` | Text | same as above (read by server code at runtime) |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Text | same as above |

   - `APP_ENV` (`staging`) and `LOG_LEVEL` are set in `wrangler.jsonc`.
   - `keep_vars` keeps the dashboard values on every deploy.

5. **Supabase → Authentication → URL Configuration:**
   - Set **Site URL** to `APP_BASE_URL`.
   - Add `APP_BASE_URL/**` to the redirect URLs, so password reset and invitation links work.

After that, every push to `main` builds and deploys automatically.

## 2. What the build does

`npm run cf:build`:
1. `scripts/patch-opennext.mjs` applies a small fix to the adapter. The adapter (1.20.10) doesn't bundle `preview-props.json`, which Next 16.4 needs, so without the fix every page returns 500.
   - The adapter version is **pinned**.
   - When upgrading it, check whether the patch is still needed; the script fails loudly if the adapter changed.
2. `opennextjs-cloudflare build` runs `next build` and converts the output into `.open-next/worker.js` plus static assets.

**Notes:**
- **Cache Components / partial prerendering are off** in `next.config.ts`. Partially prerendered pages hang on Workers with this adapter. All pages here are per-user and rendered on demand, so nothing is lost.
- **Proxy (`src/proxy.ts`):** Next 16 runs it on the Node.js runtime. OpenNext marks that "experimental" on Cloudflare. It was tested locally (redirects and session refresh work).
- **Worker size:** about **2.9 MiB** compressed, with `minify` on. The Workers **free** plan limit is 3 MiB; the paid plan ($5/month) allows 10 MiB. As later phases add code, expect to need the paid plan.

## 3. Testing locally (optional)

```bash
npm run cf:build
npx wrangler dev --port 8788 --minify   # runs the worker in Cloudflare's local runtime (workerd)
```

Local runs read `.env.local` values baked in at build time. Runtime secrets for local runs go in `.dev.vars`, which is git-ignored.

**Verified on 2026-10-12 with the local Workers runtime:**
- `/login`, `/auth/forgot` and `/` return 200.
- `/api/health` returns 200.
- `/staff` without a session redirects to login.
- A signed-in demo client owner loads `/app` and `/portal` with data from Supabase.

## 4. Turning staff MFA back on (before production)

Run in the Supabase SQL editor:

```sql
update private.settings set value = 'true'::jsonb where key = 'require_staff_mfa';
```

Staff will then be asked to enrol or verify an authenticator app at sign-in.
