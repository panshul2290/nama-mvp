# Mobile number sign-in (0019)

Not every driver has an email, but every driver has a mobile number. From migration
`0019_mobile_auth.sql` the **mobile number is the main identity** and email is optional:

- **Password** for everyday sign-in.
- **SMS code** to verify the number at sign-up, and to reset a forgotten password.

## What changed

| Area | Before | Now |
|---|---|---|
| Sign-up (`app/signup`, every role) | email + password; mobile optional | **mobile (required)** + password; email optional. `supabase.auth.signUp({ phone, password })`, then a code step on the same page (`verifyOtp({ phone, token, type: 'sms' })`) with resend (60 s cooldown) and *Change number* |
| Sign-in (`app/login`) | email + password | one field, **mobile number or email**, + password. The app works out which one you typed and calls `signInWithPassword` with `phone` or `email` |
| Password reset (`app/login/reset`) | email link only | **by mobile**: code by SMS (`signInWithOtp({ phone, options: { shouldCreateUser: false } })`), enter it, choose a new password (`updateUser({ password })`). Email accounts still get the reset link |
| Invitations (company → driver, business → member) | by email | by **mobile number** (primary) or email. Owners and business admins type either one into the same field |
| Driver sign-up banner | "give your company owner this email" | "give that number to your company owner" |
| Seeded demo accounts | email only | the same emails, **plus a verified mobile number** (see `scripts/seed.ts`), so you can demo either sign-in. Business landlines get no auth phone |

Phone numbers are stored in E.164 (`+96891234567`). `lib/phone.ts` (app) and
`public.normalize_phone()` (database) apply the same rules, and the tests check they agree:

- Omani numbers by default: 8 digits starting with 7 or 9, typed with or without `+968`, `00968` or `968`; spaces, dashes and brackets are ignored; Arabic-Indic digits are accepted.
- Other countries only with an explicit `+` or `00` prefix.
- Landlines are rejected (they can't receive the code).

### Database (`0019_mobile_auth.sql`)

- **`my_phone()`**: the caller's mobile from `auth.users.phone`, **only once `phone_confirmed_at` is set** (Supabase stores it without the `+`; this returns E.164). `my_email()` now also requires a confirmed email. Phone-only accounts have a null email everywhere.
- **Invitations:** new `phone` column; `email` is nullable; a check requires **exactly one** of the two. One pending invitation per company/organisation per number (and per email). The invitee policy, the "read the inviting organisation's name" policy and `respond_invitation` match on `invitation_is_mine(email, phone)`: a **verified** phone or a **confirmed** email, never the self-declared profile email. Consent, locking (`for update` on the invitation and the profile), the 14-day expiry and "a tanker moves only when its own driver accepts" are unchanged from the Codex review (S4).
- `owner_add_driver(p_contact)` and `org_add_member(p_contact, p_role)` take a mobile number or an email (new errors `invalid_phone`, `invalid_email`).
- **Profiles:** new private `email` column (the optional email from sign-up; readable through `my_private_profile()`, not the table). The sign-up trigger fills `phone` (E.164) and `email` from the metadata (`phone`, `contact_email`), or from the auth user. When a number is verified or changed, `profiles.phone` follows it.
- **Audit log:** `actor_email` falls back to the mobile number for accounts without an email.
- **SMS:** `public.send_sms_hook(event jsonb) returns jsonb` is the Supabase **Send SMS Auth Hook**. It writes `(phone, otp, kind)` to `public.sms_outbox` and returns `{}`. Only `supabase_auth_admin` can run it; no client role (`anon`, `authenticated`) can read or write the outbox. Rows older than a day are pruned.
- **Demo codes:** `app_settings` key `DEMO_SMS_CODES` (`off` by default). When `on`, `demo_sms_code(phone)` returns the latest code (last 10 minutes) for that number, and the code screens show **"Demo: your code is 123456"** (only in builds with `NEXT_PUBLIC_DEMO_MODE=true`).

## Supabase dashboard steps (once, before or after `npm run db:apply`)

Apply the migration first (`npm run db:apply`), because the hook function must exist before you can pick it.

1. **Authentication → Sign In / Providers → Phone**
   - Turn **Enable phone provider** on.
   - Turn **Confirm phone** on (new numbers must enter the SMS code before they can sign in).
   - **SMS provider:** the dashboard asks for one even when the hook replaces it. Pick **Twilio** and enter placeholder values (for example Account SID `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, Auth Token `placeholder`, Message Service SID `placeholder`). While the Send SMS hook is enabled, Supabase calls the hook and never uses these.
   - Optional: **SMS OTP expiry** (default 60 s is short for a demo; 300 s is comfortable) and **SMS OTP length** 6.
   - Save.
2. **Authentication → Hooks → Add hook → Send SMS hook**
   - Hook type: **Postgres**.
   - Schema `public`, function **`send_sms_hook`**.
   - Enable and save. (The migration already grants `execute` to `supabase_auth_admin` and revokes it from everyone else.)
3. **Authentication → Rate Limits:** the default *SMS messages sent per hour* is low (30). Raise it for a demo with many sign-ups.
4. **Email provider:** leave it on so email accounts (seeded demo users, NWS staff) keep signing in.
5. **Demo only, show the code on screen:** in the **SQL Editor**, as the database owner:
   ```sql
   update app_settings set value = 'on' where key = 'DEMO_SMS_CODES';
   ```
   and make sure the app is built with `NEXT_PUBLIC_DEMO_MODE=true`. Turn it off again with `... set value = 'off' ...`. **Never leave it on in production:** anyone could read the code for any number.
6. Re-run `npm run seed` so the demo accounts get their verified mobile numbers (each seeded customer, driver and owner can then sign in with the number in `scripts/seed.ts` and `SEED_PASSWORD`, e.g. driver `+968 9555 0142`).

Until steps 1–2 are done, phone sign-up and reset fail with "Sign-in by mobile number isn't switched on". Email sign-in keeps working.

## Switching to a real SMS gateway

The only place that would send an SMS is marked **`SMS GATEWAY SEAM`** in `send_sms_hook` (`0019_mobile_auth.sql`). Three options:

1. **Supabase's built-in provider (Twilio, MessageBird, Vonage, Textlocal):** fill in real credentials under the Phone provider and **disable the Send SMS hook**. Simplest; the outbox then stays empty (turn `DEMO_SMS_CODES` off).
2. **HTTP hook (Omani gateway, e.g. Omantel / Ooredoo bulk SMS, or Twilio via your own code):** deploy a Supabase Edge Function (or any HTTPS endpoint) that verifies the hook signature (the dashboard shows the secret), reads `user.phone` and `sms.otp`, and calls the gateway. Switch the hook type from *Postgres* to *HTTPS* and point it at the function. Keep the Arabic/English message text there.
3. **Stay on the Postgres hook and call out with `pg_net`:** enable the `pg_net` extension, store the gateway key in **Vault**, and add a `net.http_post(...)` call at the seam (the comment shows the shape). `pg_net` is asynchronous, so fill `sms_outbox.sent_at` / `gateway_ref` from a delivery callback if you need receipts.

Whatever you choose, keep `sms_outbox` unreadable by clients, and turn `DEMO_SMS_CODES` off.

## Notes and limits

- The optional email on a phone account is **contact data only** (`profiles.email`). It isn't verified and isn't a sign-in method; email invitations never match it. Attaching it to the auth user (`updateUser({ email })`, with a confirmation email) can come later.
- Existing email accounts sign in as before. To add a mobile number to one, set it with a verified phone (the seed does this with the service role); a self-service "add your number" screen is not built yet.
- NWS staff are still made staff by email (`staff_set_role_by_email`).
- Unknown numbers on the reset screen get the same "code sent" answer as known ones, so the screen can't be used to find out who has an account.
- Tests: `npm run test:unit` (phone normalisation), `npm run test:db` (the `PHONE` suite: hook, outbox access, demo setting, invitations by phone: verified-only matching, consent, expiry, cross-company). On the live Supabase run (`test:db:supabase`) the `PHONE` suite only checks normalisation and grants and skips the rest.

## WhatsApp codes and code-only sign-in (0037)

- **SMS or WhatsApp.** Sign-up, *Sign in with a code* and password reset let the person pick how the code arrives. Just before asking Supabase Auth for a code, the app calls `request_code_channel(phone, channel, lang)` (anon allowed; it records the choice for that number for 15 minutes and holds no code). The Send SMS hook reads it, writes the code to `sms_outbox` with `channel` and `lang`, renders the text from the **`login_code`** template (EN/AR, editable in NWS Settings → Notifications) and hands it to the channel's provider from the `NOTIFY` setting. With the built-in simulator the row is marked sent and a copy with the code masked (`••••••`) appears in the NWS outbox. WhatsApp falls back to SMS when the template's WhatsApp switch or the WhatsApp provider is off. Supabase still checks the code as a phone OTP (`verifyOtp({ type: 'sms' })`), whatever the channel. Demo codes show on screen as before.
- **WhatsApp Business seam:** `auth_code_deliver()` in `0037_sign_in_channels_identity.sql`. Set the WhatsApp provider to *External gateway* and send an approved *authentication* template (Meta Cloud API or a BSP) from there with `pg_net`, or switch the hook to HTTPS. Supabase Auth's own `channel: 'whatsapp'` option is not used: it only works with Twilio as the SMS provider, and the hook does not receive it.
- **Code-only sign-in** (`/login`, not the NWS portal): mobile number → code → signed in, no password. `signInWithOtp({ phone, options: { shouldCreateUser: false } })`, then the code is verified on a scratch client and the session goes through `admit()` exactly like the password path, so an account of another kind is refused and *Keep me signed in* applies. Unknown numbers get the same "code sent" answer.
