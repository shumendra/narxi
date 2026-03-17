# Copilot Instructions for Narxi (Tashkent Price Transparency)

## Architecture snapshot
- This repo has two runtime surfaces:
  - Frontend Mini App: React + Vite in `src/App.tsx`, loaded inside Telegram WebApp (`index.html`, `src/main.tsx`).
  - Bot backend: Netlify Function at `netlify/functions/webhook.js` (Telegram webhook entrypoint).
- Data store is Supabase; frontend reads/writes with `@supabase/supabase-js`, backend moderates and writes queue/admin flows.
- Moderation-first model: user submissions go to `pending_prices`; admin approves into `prices`.

## Key files to understand first
- `netlify/functions/webhook.js`: Telegram command handling, language selection, moderation callbacks, receipt scraping, admin flows.
- `src/App.tsx`: Find/report UI, trilingual text, map behavior, manual submissions to `pending_prices`.
- `netlify.toml`: Netlify build + function directory wiring.
- `.env.example`: required runtime variables.

## Required environment variables
- Backend/function: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MINI_APP_URL`.
- Frontend: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Keep secrets out of source; `.env.local` is ignored.

## Developer workflows
- Install deps: `npm install`
- Type-check: `npm run lint` (uses `tsc --noEmit`)
- Frontend local dev only: `npm run dev` (Vite)
- Production build: `npm run build`
- Netlify function behavior should be validated via deployed function URL (not only local Vite).

## Project-specific coding patterns
- Webhook must always return HTTP 200 for Telegram updates; handle errors internally and reply with bot messages.
- Bot text is language-aware (`uz/ru/en`) via `BOT_COPY`; keep all new user/admin strings localized in all three languages.
- `/start` flow: language picker first, then menu buttons with `?mode=...&lang=...` to Mini App.
- Manual reports from Mini App insert into `pending_prices` (not `prices`) with confidence metadata.
- Admin actions are callback-based (`approve_*`, `reject_*`, `block_*`, appeal callbacks); preserve callback token formats when extending.

## External integration constraints
- Telegram Mini App script is required in `index.html`; `Telegram.WebApp.ready()` and `expand()` are called in `src/main.tsx`.
- Leaflet map is used in both find and report flows; map overlays must not block pointer events.
- `ofd.soliq.uz` may timeout from Netlify egress; diagnostics endpoint exists at `/.netlify/functions/webhook?diag=1`.

## Safe change guidance
- Prefer minimal, targeted edits in existing files; avoid introducing new backend frameworks.
- Keep admin-only behavior gated by `ADMIN_TELEGRAM_ID` in webhook logic.
- If adding DB fields to moderation/approval flow, update both insertion (`pending_prices`) and approval copy path (`prices`).
- Verify changes by testing `/start`, `/pending` (admin), and Mini App report submission end-to-end after deploy.
