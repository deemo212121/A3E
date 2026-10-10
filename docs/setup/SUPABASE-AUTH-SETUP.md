# Supabase Project Setup (hosted dev, staging and production)

`supabase/config.toml` configures **only the local** stack. A **hosted** project must be configured in the Dashboard as follows. Repeat for each environment, using that environment's app URL.

## 1. Authentication settings

| Setting | Where | Value |
|---|---|---|
| Allow new users to sign up | Authentication → Sign In / Providers | **Off** (accounts are by invitation only) |
| Site URL | Authentication → URL Configuration | The app URL, e.g. `http://localhost:3000` for dev |
| Redirect URLs | Authentication → URL Configuration | `http://localhost:3000/auth/confirm` (plus the staging/production equivalents) |
| Minimum password length | Authentication → Policies / Passwords | **12** |
| Password requirements | same | Lowercase, uppercase and digits |
| MFA: TOTP (App Authenticator) | Authentication → Multi-Factor | **Enabled** |
| Secure email change | Authentication → Email | Enabled (the default) |

## 2. Email templates (required for invitations and password reset)

The app verifies links on the **server**, so these templates must use the `token_hash` format.

**Authentication → Emails → Invite user**, link:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite">Accept the invitation</a>
```

**Authentication → Emails → Reset password**, link:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Reset your password</a>
```

The built-in Supabase email sender is rate-limited and meant for development. Configure a custom SMTP provider before production (deployment phase).

## 3. Apply the database migrations

The person who holds the database password runs these once per machine:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
```

Then:

```bash
npx supabase db push      # applies supabase/migrations/* not yet applied
```

Never edit an applied migration. Add a new one instead (see MIGRATIONS.md).

## 4. Create the first firm admin

Either run this (requires `SUPABASE_SECRET_KEY` in `.env.local`):

```bash
npm run bootstrap:admin -- person@firm.example
```

or run this in the SQL Editor after creating or inviting the auth user in the Dashboard:

```sql
select private.bootstrap_firm_admin('person@firm.example');
```

Both refuse to run if a firm admin already exists. All later role changes happen in the app.

## 5. Run the live cross-tenant tests (non-production projects only)

```bash
npm run test:integration
```

The tests create synthetic users and clients, attack the API directly, and delete everything afterwards. They are **skipped** without `SUPABASE_SECRET_KEY`, and they refuse to run when `APP_ENV=production`.
