# Email delivery setup (Resend → Supabase SMTP)

Supabase's built-in mailer is rate-limited (~2–3/hour) and only meant for testing.
To make signup confirmations, password resets, and invites deliver reliably for
the beta, point Supabase's auth emails at Resend's SMTP.

## Step 0 — you need a domain (the real prerequisite)

Resend will only send from an address on a domain you can verify via DNS. The
Vercel `*.vercel.app` subdomain can't be verified (you don't control vercel.app's
DNS), so you need a domain you own.

- If you already own one (e.g. `phillumeni.com`), use it.
- If not, buy one (~$10–15/yr at Cloudflare Registrar, Namecheap, or Vercel
  Domains). This doubles as your custom app URL later (`phillumeni.com` → the
  Vercel app), so it's worth doing once.
- A subdomain is fine for sending, e.g. `mail.phillumeni.com`.

(Interim with no domain: keep using the SQL password-set for yourself and accept
the built-in mailer's rate limit for a tiny beta. Resend's `onboarding@resend.dev`
test sender only delivers to your own Resend account email — not usable for real
testers.)

## Step 1 — Resend account

1. Sign up at https://resend.com (free tier: 3,000 emails/mo, 100/day).

## Step 2 — verify your sending domain in Resend

1. Resend → **Domains** → **Add Domain** → enter your domain (or `mail.yourdomain.com`).
2. Resend shows DNS records to add — typically:
   - an **MX** record (for the sending subdomain),
   - an **SPF** `TXT` record,
   - a **DKIM** record (`TXT` or `CNAME`),
   - optionally a **DMARC** `TXT` record.
3. Add those at your domain's DNS provider (registrar, or Cloudflare/Vercel DNS).
4. Back in Resend, click **Verify**. Propagation is usually minutes, up to a
   few hours. Wait until the domain shows **Verified**.

## Step 3 — Resend API key

1. Resend → **API Keys** → **Create API Key** (Sending access is enough).
2. Copy the key (`re_…`) — you'll paste it as the SMTP **password**.

## Step 4 — point Supabase at Resend

Supabase Dashboard → your project → **Authentication** → **Emails** →
**SMTP Settings** → enable **Set up custom SMTP server**, then:

| Field         | Value                                  |
|---------------|----------------------------------------|
| Sender email  | `noreply@yourdomain.com` (verified)    |
| Sender name   | `phillumeni`                           |
| Host          | `smtp.resend.com`                      |
| Port          | `465` (SSL) — or `587` (TLS)           |
| Username      | `resend`                               |
| Password      | your Resend API key (`re_…`)           |

Save. The sender email's domain MUST match the domain you verified in Resend, or
Resend rejects the send.

## Step 5 — raise the email rate limit

Supabase → **Authentication** → **Rate Limits** → increase **"Rate limit for
sending emails"** above the built-in default (it's deliberately low until you add
custom SMTP).

## Step 6 — confirm the redirect URLs

Supabase → **Authentication** → **URL Configuration**:
- **Site URL**: `https://phillumeni.vercel.app` (or your custom domain once set).
- **Redirect URLs**: include the same origin (e.g. `https://phillumeni.vercel.app/**`).

This is what lets the password-reset link land back in the app.

## Step 7 — test

1. On the live app, click **Forgot password?**, enter your email, send the link.
2. Check that the email arrives from your `noreply@…` sender (check spam first time).
3. Open the link on the device → "Set a new password" → save → you're signed in.
4. Repeat with a fresh signup to confirm confirmation emails deliver.

## Optional — email templates

Supabase → **Authentication** → **Email Templates** lets you brand the
confirmation / recovery / magic-link emails (subject + body, with the
`{{ .ConfirmationURL }}` variable). Defaults work fine for the beta.

## Notes

- Entering the API key into the Supabase dashboard is something **you** do — I
  can't (and shouldn't) handle credentials.
- Once SMTP is live you can also turn email **confirmation** back on for signups
  if you want (Authentication → Providers → Email → "Confirm email"), since
  delivery will be reliable. It's currently off for the friends-beta.
