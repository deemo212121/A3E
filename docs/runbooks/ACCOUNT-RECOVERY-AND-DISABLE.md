# Runbook — Account Recovery and Account Disable

**Applies to:** all environments. Every action below is recorded in `audit.events` automatically, except the break-glass SQL steps (§7), which must be logged manually as described there.
**Principle:** confirm identity **out of band** (a phone call to a number already on file, or in person) before any recovery action. Never act on an email request alone.

## 1. Forgotten password (any user)

1. The user opens `/auth/forgot` and enters their email.
2. The page always says "If an account exists… a reset link has been sent", so it never reveals whether an account exists.
3. The emailed link goes to `/auth/confirm` (recovery), then `/auth/set-password`.
4. The new password must have at least 12 characters, with uppercase, lowercase and a number.

No administrator action is needed. If the email never arrives, check the Supabase Auth logs and the email-sending limits of the project (Dashboard → Authentication → Logs).

## 2. Lost two-step device (staff member)

1. Verify the person's identity out of band (see the principle above).
2. A **firm admin** (not the affected user) opens **Firm administration → Users → Reset two-step verification** and enters a reason.
   - The database function `authorize_mfa_reset` checks that the caller is an active firm admin on two-step verification and that the target is not themselves, then writes `account.mfa_reset` to the audit log.
   - The server then deletes the user's authenticator factors through Supabase Auth.
3. At the next sign-in, the user is sent to `/mfa` to enroll a new authenticator.
4. If the **only** firm admin lost their device, see §7 (break-glass).

## 3. Disable an account (compromise, departure, or suspension)

1. A **firm admin** opens **Firm administration → Users → Disable account** and enters a reason, which is required.
2. What happens, in order:
   1. `set_user_active(false)` sets `profiles.is_active = false`. **All data access stops immediately**, even for sessions that are already signed in, because every RLS helper checks `is_active`.
   2. The account is banned in Supabase Auth, so new sign-ins and token refreshes fail.
   3. `account.disabled` is written to the audit log with the reason.
3. Memberships are **kept**, so re-enabling restores the same access. To remove access permanently, also remove the person's client memberships and firm role (§5).
4. Guards: a firm admin cannot disable themselves, and the last active firm admin cannot be disabled.

If a compromise is suspected:
- Disable the account first, then review `audit.events` for that `actor_id`.
- Rotate any keys the person could have seen (§8).
- Notify the Data Protection Officer: a personal-data breach may have notification deadlines under RA 10173, which legal must confirm.

## 4. Re-enable an account

A **firm admin** opens **Users → Enable account**. This clears the disable fields, lifts the Auth ban, and writes `account.enabled` to the audit log.

## 5. Offboarding

| Who leaves | Steps |
|---|---|
| Firm staff | (1) Set the firm role to **none**, which also removes their client assignments. (2) Disable the account (§3). |
| Client user (staff or viewer) | The client owner or a firm admin/manager removes the member on the client page. Disable the account too if the person should lose all access. |
| Client owner | A firm admin/manager first adds or promotes another owner, then removes the old one. A client always keeps at least one active owner. |
| Whole client business | A firm admin/manager sets the client's status to `archived`. All client-user access stops (RLS), and firm staff keep read access for record keeping. |

## 6. Invitations

- Invitations expire after 72 hours by default (maximum 168). An expired or revoked invitation cannot be accepted.
- An invitation can only be accepted by the signed-in user whose **confirmed** email matches. There are no bearer links that grant access.
- To cancel one: **Pending invitations → Revoke** (firm admin, manager, or the client's owner).

## 7. Break-glass (no firm admin can sign in)

Use only when **no** firm admin can act. Two people must be present: the firm owner and the person with Supabase dashboard access. Log the action afterwards.

| Situation | Action in Supabase Dashboard → SQL Editor |
|---|---|
| No firm admin exists at all (fresh project) | `select private.bootstrap_firm_admin('person@firm.example');`. The function refuses if any firm admin exists. Alternatively, run `npm run bootstrap:admin -- person@firm.example`. |
| The only firm admin lost their MFA device | Verify identity, then `delete from auth.mfa_factors where user_id = '<uuid>';` |
| The only firm admin was disabled by mistake | `update public.profiles set is_active = true, disabled_at = null, disabled_by = null, disabled_reason = null where id = '<uuid>';` then lift the ban: Dashboard → Authentication → Users → the user → unban. |

Then record what was done:

```sql
select audit.log_event('breakglass.<what>', null,
  jsonb_build_object('performed_by', '<names>', 'reason', '<reason>', 'ticket', '<ref>'));
```

## 8. Secret key compromise

1. Supabase Dashboard → Project Settings → API Keys: **create a new secret key, then revoke the old one.**
2. Update the server environment: `.env.local` in development, the hosting secret store in production. Restart or redeploy.
3. Review the Auth logs and `audit.events` for actions taken by system (null) actors during the exposure window.

## 9. Where to look

| Question | Query (SQL Editor, as postgres) |
|---|---|
| What did a user do? | `select * from audit.events where actor_id = '<uuid>' order by occurred_at desc;` |
| Who changed a client's members? | `select * from audit.events where client_id = '<uuid>' and table_name = 'client_memberships' order by occurred_at desc;` |
| All disables and MFA resets | `select * from audit.events where action in ('account.disabled','account.enabled','account.mfa_reset') order by occurred_at desc;` |
