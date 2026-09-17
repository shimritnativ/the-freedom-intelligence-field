# CLAUDE.md: The Field (thefieldai.app)

This file gets auto-loaded by Claude Code every session inside this repo. It carries the durable context that a fresh Claude needs to be useful on this project without asking Geo to re-explain everything.

If you're reading this as a human: this is the operator manual. Update it when a rule changes.

---

## Who's building this

**Geo (Geovanna Amaral)**: COO for Shimrit Nativ, sole builder of The Field. She makes every product, UX, and code decision. She is not a career developer, so she deploys through GUI tools (GitHub Desktop, Vercel dashboard, Neon SQL editor) rather than Terminal. She's casual, direct, lowercase, occasionally drops punctuation. When she asks "should we do X" treat it as her deciding, not exploring.

**Shimrit Nativ**: founder, brand voice, source of the Human Instrument® methodology that The Field teaches. She does not code. All product-side communication with her goes through Geo.

---

## What The Field is

**thefieldai.app**: an AI-guided coaching product delivered as a web app, embedded inside Kajabi for members. The chat is Shimrit's voice, structured around the Human Instrument methodology.

Three product tiers, all under one codebase:

- **Preview** (`user_tier = 'preview'`): anyone who bought the **72-Hour Power Reset** (€9). Three-day guided arc: Day 1 Truth, Day 2 Decision, Day 3 Action. 72h countdown after first login. Includes optional Day 4 bonus.
- **Full** (`user_tier = 'full'`): **The Field Unlimited** members (€64.71/mo net or €640/yr net). Unlimited daily access, 20+ guided processes, free-form chat with retrieval-augmented Shimrit "brain".
- **Workshop** (`user_tier = 'workshop'`): €47 VIP tier for the September 21-23, 2026 "All The Way To The Top & Beyond" workshop. Geo calls this **"The Field ATWT"**. Reset is delivered as "Steps" not "Days", no 72h clock, no Unlimited upsell, stripped-down sidebar, workshop-specific portal. Workshop-tier UI/copy changes must NEVER touch preview or full tiers.

**Adjacent product:** a workshop-integration add-on for full or preview members who buy just the integration content. Granted via `users.workshop_addon_expires_at` timestamp, not a tier switch.

**The Reset IS The Field.** The Reset is the 3-day guided experience inside The Field itself. Same environment, same interface. Never treat the Reset as a separate course or product.

**Audience.** The ICA (Ideal Customer Avatar) skews ~90% women but the product is for everyone. Use inclusive language ("you", "they") in every copy, LP, email, and strategy doc. Do not name the ICA persona (Karin, Mette) in customer-facing copy.

---

## Repo + tech stack

- **Hosting:** Vercel. Team `myp-team`, project `the-field`, production `https://www.thefieldai.app`.
- **Git remote:** `https://github.com/shimritnativ/the-freedom-intelligence-field` (renamed from `myp-ascension`; the old URL still redirects). Vercel is Git-connected to this repo and auto-deploys every push to `main`.
- **DB:** Neon Postgres.
- **AI:** Anthropic Claude (Sonnet 4.6 currently) for chat; OpenAI Whisper for transcription; OpenAI gpt-image-1 for generated images.
- **Frontend:** vanilla HTML/CSS/JS. NO React, NO build step. `app.html` at the REPO ROOT is the main app; `admin.html` is the roster. There is no `public/` folder in the repo. Vercel's output directory rule is "`public` if it exists, or `.`", so in this repo everything is served from the root and `vercel.json` rewrites point at root paths.
- **Serverless functions:** Vercel Node functions under `api/`.
- **Payments:** ThriveCart → Zapier → `/api/admin/manual-purchase` (currently). Direct `/api/webhooks/thrivecart` endpoint exists but not yet cut over (see Outstanding Work item 6).
- **Membership platform:** Kajabi (grants entitlements via `/api/webhooks/kajabi`).
- **External services:** PDFShift (PDF export), OpenAI (Whisper + image gen), Anthropic (chat), Vercel Cron (auto-reconcile every 10 min), Meta Pixel (Lead + Purchase events).

### Key directories

```
api/                       Vercel serverless functions
  admin/                   Admin dashboard endpoints (metrics, ads-metrics, manual-purchase, auto-reconcile, etc.)
  auth/                    Email-code login (request-code, verify-code)
  webhooks/                Inbound: kajabi.js, thrivecart.js
  unlimited/               Unlimited chat + session endpoints
  chat.js                  Reset chat (preview/workshop tier)
  transcribe.js            Whisper transcription
  generate-image.js        gpt-image-1 image generation (workshop integration Beyond Potential Board)
  state.js                 GET /POST for user state (rehydrates client on load, saves mutable fields)
  export-pdf.js            PDFShift proxy for Reset/Field conversation exports
lib/
  db.js                    All Postgres queries (getUserBySessionToken, grantEntitlement, revokeEntitlementByEmail, etc.)
  prompts/
    master-principles.js   Shared Field mentor persona (auto-injected into every process)
    processes/             Individual guided processes (day1, day2, day3, and Unlimited processes)
    index.js               Prompt loader for the Reset days + PROMPT_VERSION constant
  brain/                   Retrieval-augmented Shimrit content (embeddings + Postgres pgvector)
  memory.js                Cross-process user memory (durable facts from past sessions)
app.html                   Main member app (huge single file: sidebar, chat, modals, all inline JS+CSS)
admin.html                 Admin roster + dashboards
reset.html try.html terms.html privacy.html impressum.html the-field-website.html
                           Other root-level static pages, routed by vercel.json rewrites
scripts/
  migrate.js               Migration runner (the only file in scripts/)
migrations/                Numbered SQL files, TOP LEVEL not under scripts/. Repo currently has 001_initial_schema.sql
                           through 006_session_pinning.sql
```

---

## Deploy workflow: push to `main`, Vercel auto-deploys

Geo prefers GUI tools and does not want to be handed raw `git` commands to run herself. That preference stands. What changed is that this folder is now a real clone, so Claude Code can do the git work for her when she asks.

**Default path (her preference):**
1. Edit files in this repo.
2. She opens GitHub Desktop, reviews the diff, commits with a short message, clicks Push.
3. Vercel auto-deploys in 1-2 minutes. She can watch it on vercel.com under the Deployments tab.

**Direct path (only when she asks Claude to push):** Claude Code can run `git add` / `git commit` / `git push` in this clone. Never push without her go-ahead, and never run `vercel --prod` to deploy: production must come from a `main` push so GitHub stays the source of truth.

### Accounts and access (important)

The repo is owned by the personal account `shimritnativ` ("MYP Support", support@shimritnativ.com). Every commit in the history was made by that account through the GitHub web editor, which is why the messages all read like "Update app.html".

- `ge-amaral` (Geo's own GitHub account) has **read-only** access to this repo. A push as `ge-amaral` fails with a 403.
- Pushing requires being authenticated as `shimritnativ`. Run `gh auth login` once and sign in as support@shimritnativ.com, then `gh auth setup-git`.
- This clone's **local** git identity is pinned to `MYP Support <support@shimritnativ.com>` so new commits match the existing history. The machine's global git identity is something else, so set the local identity explicitly on any new repo instead of relying on the global default.
- The `vercel` CLI is authenticated as `support-myp` on team `myp-team`, and `vercel ls` / `vercel inspect` work already.

**Read-only checks Claude can run any time:** `git log`, `git status`, `git diff`, `vercel ls`, `vercel inspect <url>`, `vercel project inspect the-field`.

**Migrations:** she runs SQL directly in the Neon console (Untitled query editor). Give her the SQL as a copy-pastable block. Always use `IF NOT EXISTS` / `IF EXISTS` guards for idempotency.

**After every file edit in a response, list every modified file** at the end so she has a clear checklist of what to push. In Cowork mode this was `mcp__cowork__present_files`; in Claude Code just list the absolute paths.

---

## Hard rules: do not violate

### Zero em dashes
Never use em dashes (—) in any reply, comment, code, prose, or file Claude writes. Use periods, commas, colons, semicolons, or parentheses instead. Hyphens (-) and en dashes (–) are fine. Geo has flagged this repeatedly. Scan every response before sending.

### "The Field" is capitalized
Always **The Field** with capital T and capital F. Not "the Field", not "the field". Same rule for **The Reset**, **The Instrument**, **The 72-Hour Power Reset**, **The 5-Minute Preview**, **Master Your Path**. Apply everywhere: marketing, legal, system prompts, modal copy, support replies, code comments.

### Sessions are private
Never quote, paraphrase, or reference a member's private Field conversation content in outreach or replies TO that member. The Field's promise is that what someone shares with the AI is theirs alone. Speak generally about what a process/product offers. Only exception: if the member themselves brings up their conversation content in an email TO the team, we can reference what they said in their email (not what they told the AI).

### Whisper prompt bias is off: keep it off
`api/transcribe.js` MUST NOT pass a `prompt` field to Whisper. Whisper hallucinates the prompt into silences and returns it as fake member speech. Two confirmed incidents: Antonella (Jul 2026) got fabricated "Day 4. Decision..." list; Susse (Aug 2026) got verbatim marketing sentence about the Power Reset. Small mistranscription cost (e.g. "Human Instrument" → "human instructor") is accepted; the fix is no prompt at all until a proven mitigation (VAD trimming or post-hoc bias-string stripping) is built.

### Tier rehydration whitelist
Any new value in the `user_tier` enum must be added to TWO whitelists in `public/app.html`:
1. Rehydrate check around **line 11326** (`resumeSession` / page-open path)
2. EMBED_MODE promotion check around **line 9724** (fresh-start path)
Otherwise the API returns the new tier correctly but the client silently drops it and renders default (preview) UI. Also grep `state.tier === "full"` and `state.tier === "preview"` for other spots that may need the new tier (view routing, resetSectionExpanded default). This bug shipped once for the workshop tier (Aug 2026); do not repeat it.

### Field mentor never evaluates
The mentor persona in `lib/prompts/master-principles.js` bans ranking one member share as superior to another. No "most honest / real / true / deep", no "closer to actually", no "pattern underneath the pattern", no "now we're getting somewhere". Applies to tone too: the Field does not become more animated or reverent on vulnerable material. Replacement phrases: "Yes.", "Received.", "That is what you named.", "Let that resonate.", "Stay with that."

---

## Voice for member-facing copy

When Geo asks to draft an email, WhatsApp reply, LP section, or system-prompt text FROM Shimrit / Geo / the team TO members:

- **Use contractions**: "you're", "we'd", "it's", "you'll". Never "you are" instead of "you're".
- **Warm emojis, sparingly**: 🙏🏻 and ❤️ land well. Usually one at the end of a soft moment or invitation question. Never emoji-stack. Never in the middle of a hard sentence.
- **Reframe as relationship, not transaction**: "because you're already one of our clients and we'd love you to experience something deeper" beats "because you gave feedback that will help others".
- **Bullets:** `• Name: description` for emails. Use `- ` hyphens for anything going to WhatsApp (the • character does not paste cleanly).
- **Skip flowery signoffs**: end with the invitation question itself. If a signoff is needed, keep it short.
- **"Many different" not exact counts**: "there are many different guided processes" reads warmer than "there are 18 guided processes" in member-facing copy.
- **CTA is a question, not a directive**: "Would you like me to send you the link?" not "Click here to upgrade."
- **Soft-opener pattern for feedback replies:** "Thank you for the feedback about [thing]. You're right, and you helped us see something important." Then move to the reframe.

Internal comms (dashboards, SQL, docs for the team) do NOT need this voice. Exact numbers and direct language are fine there.

Geo herself writes casual, lowercase, with occasional "lol" and "amazing". When she asks Claude to "summarize this for the team" she wants Geo-voice, not corporate.

---

## Pricing table: canonical gross / net / stored value

`purchases.amount_cents` stores **NET** (without VAT). The admin dashboard shows NET by default. "Without VAT" in Geo's words = net.

| Product | Coupon | Gross (VAT incl.) | Net (stored) | amount_cents |
|---|---|---|---|---|
| Power Reset | none | €9.00 | €7.56 | 756 |
| Power Reset | POWER50 (50% off) | €4.50 | €3.78 | 378 |
| Power Reset | LAUNCHTEAM (100% off) | €0 | €0 | 0 |
| Power Activation bump | never a coupon | €16.99 | €14.28 | 1428 |
| Unlimited monthly | none | €77 | €64.71 | 6471 |
| Unlimited monthly | LAUNCHTEAMUNLIMITED (75% off) | €19.25 | €16.18 | 1618 |
| Unlimited yearly | none | €777 | €640 | 64000 |
| Unlimited yearly | LAUNCHTEAMUNLIMITED (75% off) | €190.40 | €160 | 16000 |
| Any product | GEO100 / GEOALL | €0 | €0 | 0 |
| Workshop VIP (ATWT €27 tier) | none | €27 | €22.69 | 2269 |

**VAT:** flat 19% (German VAT). No product-specific tax weirdness.

**Rules:**
- Power Activation is ALWAYS full price. No coupon applies to it, not even POWER50 or LAUNCHTEAM. `coupon_code = NULL` on every Activation row.
- LAUNCHTEAMUNLIMITED works on BOTH monthly and yearly Unlimited (confirmed 2026-07-01).
- LAUNCHTEAM (Reset-side team coupon) → confirm with Geo before excluding from revenue metrics.
- Do NOT put LAUNCHTEAMUNLIMITED in `EXCLUDED_COUPONS` in `api/admin/metrics.js`: it's a discount, not a free comp.

---

## ThriveCart + Kajabi integration

### Payment flow
1. Buyer clicks CTA on `go.shimritnativ.com/the-power-reset` (organic) or `.../the-power-reset-ads` (paid).
2. LP tracking snippet (`ghl-landing-tracking-snippet.html`) rewrites the CTA href to append UTM params as BOTH `utm_X=Y` and `passthrough[utm_X]=Y` (ThriveCart's Zapier integration only surfaces the `passthrough[X]` syntax, not plain `utm_X`).
3. ThriveCart processes checkout → fires Zap.
4. Zap POSTs to `/api/admin/manual-purchase` (currently) or `/api/webhooks/thrivecart` (once cut over).
5. Simultaneously, Kajabi grants the offer entitlement → Kajabi webhook fires to `/api/webhooks/kajabi?secret=XXX&grant=preview|full` → flips `users.tier`.

### ThriveCart URL map
- **Ads funnel:** LP `go.shimritnativ.com/the-power-reset-ads` → checkout `masteryourpath.thrivecart.com/power-reset-ads` → product label "The Power Reset - Ads"
- **Organic funnel:** LP `go.shimritnativ.com/the-power-reset` → checkout `masteryourpath.thrivecart.com/the-power-reset` → product label "The Power Reset"
- Meta paid campaigns filter by name via `META_ADS_CAMPAIGN_INCLUDE` env var.

### Webhook drops are real
ThriveCart silently drops webhooks for some sales. Confirmed 5+ cases through 2026-06-24 (Antonella, Alexandra, Anne Bork, Sofie, Kaija). Recovery layer: `api/admin/auto-reconcile.js` runs every 10 min via Vercel cron. Scans reliable Kajabi activation webhooks in the last 24h, finds emails with no matching purchase row, inserts a placeholder with `raw_payload.needs_verification = true` and default amounts from `inferDefaults()`. Refresh button passes `?force=1` to skip the 5-min grace window. When a placeholder amount is wrong, correct via admin roster edit form or targeted UPDATE.

### Kajabi payload extraction
Kajabi's real payload nests everything under `payload.member_email`, `payload.member_id`, `payload.member.email`, etc. `api/webhooks/kajabi.js` checks nested first, then top-level. Add both shapes when extending.

### Kajabi product-tagging was reverted
A `&product=` URL param tagging system was built then rolled back 2026-06-24 to keep things simple. Known limitation: multi-product Kajabi-direct buyers get one placeholder and need manual correction. If revisiting: files were `api/webhooks/kajabi.js` (URL param reading + payload injection) and `api/admin/auto-reconcile.js` (product-aware dedup).

### Race condition on tier revoke
`revokeEntitlementByEmail` in `lib/db.js` has a 30-minute guard preventing a stale revoke from wiping a fresh grant. **This window is too short for real-world delayed cancellations** (Monika's Sep 2026 case: a monthly-plan cancellation revoked her fresh yearly grant). Widen to 30 days when time permits. Not yet shipped.

---

## Ads attribution: hierarchy, first match wins

Order matters. Any admin metric that buckets members as "Meta ads" vs "Organic" must use this exact hierarchy:

1. **Explicit non-ads utm_source** wins over everything: `utm_source=whatsapp` or `utm_source LIKE '%email%'` / newsletter / klaviyo / mailchimp / kajabi → **NOT ads**.
2. Explicit ads UTMs: `utm_campaign IN (cold, warm)` OR `utm_source IN (meta, facebook, instagram, fb, ig, power-reset)` → **Meta ads**.
3. Fallback ads (only when `utm_source` is empty): `utm_medium IN (paid_social, paidsocial, cpc, ppc)` OR `product_name LIKE '%- Ads'` → **Meta ads**. NEVER apply these when utm_source is set to something else.
4. Any other tracked `utm_source` → "Other tracked".
5. No UTMs at all → "Organic / Direct".

**Files enforcing this logic (July 2026):**
- `api/admin/metrics.js`: `source_bucket` CASE (~line 1015), channel attribution CASE (~line 1188)
- `api/admin/ads-metrics.js`: `loadTotalAdsSignups()` (~line 613)
- `public/admin.html`: `formatSource()` frontend classifier (~line 7028)

Also required: `api/admin/metrics.js` must `SELECT u.utm_medium` or the frontend classifier can't apply the hierarchy.

**GHL tags are unreliable proxies for real Field engagement.** GHL "completed day 3" tags fire on Kajabi lesson clicks, not on actual Field usage. Source of truth is Neon `messages` (`role='user'`) + `day_completions`. A member can have "completed day 3" GHL tag and zero Field messages.

---

## User memory + language preference

- **Stored on `users` table** as durable columns (`display_name`, `preferred_language`, `workshop_expires_at`, `workshop_addon_expires_at`, `terms_accepted_at`, etc.).
- **Cross-process memory** (durable facts extracted from past sessions) lives in `lib/memory.js` and is loaded via `loadUserMemory(userId)`. Injected into both `/api/chat` and `/api/unlimited/chat` system prompts as a `---` block.
- **Language preference** (`preferred_language`, ISO 639-1 code) drives both Whisper transcription language hint AND Field response language. When set, Whisper stops guessing between related languages (Danish/Swedish); when NULL, Whisper auto-detects. The Field prompts pick up the preference via `buildLanguageOverride()` and reply in the chosen language regardless of transcribed input language.
- **Allowed language codes:** `en, it, da, sv, no, fi, es, pt, fr, de, nl, he`. Any other value is rejected server-side.

---

## /try LP nurture: already exists
Do not propose "build a 5-day activation email sequence" as new work. Geo already has post-form nurture in GHL for /try LP form-completers who did not purchase. Confirmed 2026-08-12. If proposing a specific gap (subject line test, new step), name that gap directly.

---

## Outstanding work backlog (established 2026-07-01, still current)

### HIGH: affects daily dashboard accuracy
1. **Zap UTM setup**: hardcode `utm_source=meta`, `utm_medium=paid_social`, `utm_campaign=meta_ads` in ads Zaps and `utm_source=organic` in organic Zaps. Endpoint already accepts them.
2. **Verify Katrine's `resolveActiveDay` fix**: she should paste Day 1 prompt and land on Day 1 after the `MIN(current_day, timeUnlocked)` deploy. Awaiting her confirmation.

### MEDIUM: improves the product
5. **Tooltip Phase 4-5**: Revenue tab (by product/coupon/day) + Intelligence tab (per-segment "what to do with this list"), then Engagement / Notifications / Launch Tracker.
6. **Switch from Zapier to ThriveCart direct webhook.** `/api/webhooks/thrivecart` endpoint exists; ~30-min task: config in ThriveCart + set `THRIVECART_WEBHOOK_SECRET` in Vercel + disable Zapier. Biggest single lever: permanently closes the missing-bump gap.
7. **Intelligence tab UX audit**: plain-language explanation per segment card.

### LOW: polish
8. Meta Pixel verification + AEM setup in Events Manager (5 min for iOS 14.5+ counts).
9. Financial audit bugs 3 + 5 (ads daily signups reconciliation edge case; zero-spend campaigns).
10. One-time ThriveCart API reconciliation script (~3h, permanently closes drift).
11. Anthropic admin key verification (Live API returns €0; verify real numbers appear after a few weeks).

### Ongoing / not yet shipped
- **Widen `revokeEntitlementByEmail` guard from 30 min to 30 days** in `lib/db.js` (Monika Sep 2026 case).
- Real Day 2 and Day 3 workshop-integration process content (currently placeholders in `lib/prompts/processes/workshop-integration.js`).

---

## Common admin tasks: quick reference

### Grant workshop-addon to an existing member
```sql
UPDATE users
SET workshop_addon_expires_at = '2026-10-02 23:59:59+00',
    updated_at = NOW()
WHERE email = 'member@example.com';
```
Or use `/api/admin/grant-workshop-addon` with admin token.

### Grant workshop VIP tier manually
Set `users.tier = 'workshop'::user_tier` and `users.workshop_expires_at`. Enum casting is required or `ON CONFLICT DO UPDATE` fails with "column tier is of type user_tier but expression is of type text".

### Set a member's preferred language
```sql
UPDATE users SET preferred_language = 'en', updated_at = NOW() WHERE email = '...';
```

### Merge two accounts (member has two emails)
Do it in a transaction:
```sql
BEGIN;
UPDATE purchases  SET user_id = <target_id> WHERE user_id = <source_id>;
UPDATE sessions   SET user_id = <target_id> WHERE user_id = <source_id>;
UPDATE messages   SET user_id = <target_id> WHERE user_id = <source_id>;
UPDATE folders    SET user_id = <target_id> WHERE user_id = <source_id>;
-- copy any preserved fields from source to target
DELETE FROM users WHERE id = <source_id>;
COMMIT;
```
Always verify with SELECTs before running. Also update the ThriveCart subscription email so the next monthly charge doesn't re-create the old row.

### Diagnose a "missing sale"
1. `SELECT * FROM webhook_events WHERE source = 'thrivecart' AND payload::text LIKE '%email%'`: if zero rows, ThriveCart dropped the webhook.
2. Check `purchases` for the email. Auto-reconcile should have inserted a placeholder within 10 min via Kajabi as backup signal.
3. If the placeholder amount is default (wrong), correct it via admin roster edit or SQL.

---

## External URLs + services

### Field app
- Main app: `https://thefieldai.app`
- Admin: `https://thefieldai.app/admin`
- Workshop VIP portal: `https://go.shimritnativ.com/atttbeyond-vip`
- Full-tier portal: `https://www.shimritnativ.com/products/the-freedom-intelligence-field`
- Reset portal: `https://www.shimritnativ.com/products/the-power-reset`

### Marketing LPs
- Ads LP: `https://go.shimritnativ.com/the-power-reset-ads`
- Organic LP: `https://go.shimritnativ.com/the-power-reset`
- /try LP: `https://hello.thefieldai.app/try`
- Booking: `https://api.leadconnectorhq.com/widget/bookings/connectcall-masteryourpath`
- The Freedom Mastermind (application): `https://api.leadconnectorhq.com/widget/bookings/masteryourpath/book`

### Env vars (Vercel)
- `ANTHROPIC_API_KEY`: Claude chat
- `OPENAI_API_KEY`: Whisper + image gen
- `PDFSHIFT_API_KEY`: PDF export (fallback: browser print dialog)
- `KAJABI_WEBHOOK_SECRET`: Kajabi inbound
- `THRIVECART_WEBHOOK_SECRET`: ThriveCart inbound (once cut over)
- `ADMIN_TOKEN`: admin endpoint auth
- `ALLOWED_ORIGINS`: CORS allowlist
- `META_ADS_CAMPAIGN_INCLUDE`: Meta campaign name filter (ads funnel only)
- `POSTGRES_URL`: Neon connection (set automatically by Vercel Postgres integration)

### Canonical social URLs (use these EXACTLY, do not guess by handle)
- Facebook: `https://www.facebook.com/ShimritNativMYP/` (note `MYP` suffix)
- Instagram: `https://www.instagram.com/shimritnativ/` (no dot)
- YouTube: `https://www.youtube.com/@shimritnativ`
- LinkedIn: `https://www.linkedin.com/in/shimrit-nativ/`
- TikTok: `https://tiktok.com/shimritnativ` (no `@` prefix)
- Spotify podcast: `https://open.spotify.com/show/4pgBqwRUbGyq3a4IioAHqC?si=e0de1f6966634ad0`
- Apple Podcasts: `https://podcasts.apple.com/br/podcast/the-human-instrument-mastery-podcast-with-shimrit-nativ/id1796883694?l=en-GB`

---

## Things that will bite you if you forget

- **`user_tier` enum casts.** SQL like `SET tier = CASE WHEN ... THEN 'workshop' ELSE 'preview' END` will fail with "column tier is of type user_tier but expression is of type text". Add `::user_tier` on each branch: `THEN 'workshop'::user_tier ELSE 'preview'::user_tier`.
- **Vercel serverless module caching.** Prompt or lib changes only take effect after redeploy. Editing `lib/prompts/*.js` locally and running SQL will not update behavior: you need to push and let Vercel rebuild.
- **`app.html` is huge and single-file.** Search by line number (grep + edit at absolute line), not by file. State object is around line 4980; render function much lower.
- **`insertMessage` returns the row.** Use its `id` if you need to update the message later (e.g. `[[genimg:PROMPT]]` → `[[img:BASE64]]` replacement).
- **max_tokens.** `/api/unlimited/chat` runs at 4096 (bumped from 1024 after Antonella's LinkedIn doc got truncated). When `stop_reason: max_tokens` fires, append a length-limit note to the reply.
- **Prior chat leak.** Do not paste past conversation excerpts into system prompts with markdown headers or speaker markers. That format taught the model to recite excerpts verbatim. Flat prose only, small excerpt count (2 messages default, 4 for Reset).
- **RECENT CHAT EXCERPTS phrasing.** Never label the excerpt block explicitly. Weave it into the memory section.

---

## Getting started with Claude Code in this repo

```
cd /Users/ge_amaral/Projects/the-field
claude
```

**This clone is the source of truth.** `~/Projects/the-field` is the only full local clone of the live repo. Two other folders on this Mac look like the project but are not:

- `/Users/ge_amaral/Documents/Claude/Projects/The Freedom Intelligence Field/The Field` is an untracked copy with a different layout (HTML under `public/`). It holds work that was never pushed, including `workshop.html`, `unlimited.html`, `embed.html`, roughly 15 extra `api/` endpoints, `lib/ghlWebhook.js`, and the whole `scripts/migrations/001-018` set. None of that is deployed. Treat it as an archive to pull from deliberately, not as a place to edit.
- `~/myp-ascension` is a stale 4-commit stub from May 2026. Ignore it.

Local-only config that is gitignored and already in place here: `.env.local`, `.env.production.local`, `.vercel/project.json`.

Claude Code will auto-load this `CLAUDE.md` on every session. Anything above the fold applies to every task without you needing to re-say it. Ask specific questions ("what changed in the language pref system last week"), or give tasks ("add a language toggle to the admin roster edit form"), and it'll work from this context.

If a rule changes, update this file in the same PR as the rule change. Do not let the doc drift.
