# Essentially PostingPilot — Backend (NestJS)

The API for PostingPilot. Every route the app used to serve from Next.js
(`/api/*`) now lives here as a NestJS controller/service, under the same
`/api` path prefix so the frontend only had to change origin, not paths.

## Stack

- **NestJS 10** on Express
- **Supabase** (service-role client) for all data access — single shared
  workspace, every row belongs to a fixed `OWNER_ID`
- Ported integration helpers in `src/lib/*.js` (Facebook, Instagram, YouTube,
  Canva, AI, compliance, …) — kept as plain JS, imported via `allowJs`

## Auth model

The frontend sends the Supabase session token as `Authorization: Bearer <token>`.
`SupabaseAuthGuard` (global) validates it and attaches `{ user, profile }` to the
request. Routes opt out with `@Public()`:

- **Public (no user):** `signup`, `team/exists`, `team/bootstrap`, all `auth/*`
  OAuth start+callback routes, and all `cron/*` routes (these check `CRON_SECRET`).
- Everything else requires a valid Bearer token.

Errors are rendered as `{ "error": "<message>" }` (see
`common/http-exception.filter.ts`) to match the original API contract.

## Setup

```bash
cd backend
npm install
cp .env.example .env      # fill in Supabase + integration secrets
npm run dev               # http://localhost:4000/api  (watch mode)
```

Health check: `GET http://localhost:4000/api/health`.

## Environment

See `.env.example`. Key values:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- `CORS_ORIGINS` — comma-separated frontend origins (default `http://localhost:3000`)
- `FRONTEND_URL` — where OAuth callbacks send the browser back to
- Integration secrets: `FACEBOOK_*`, `GOOGLE_*` / `YOUTUBE_*`, `CANVA_*`, `ANTHROPIC_API_KEY`
- `CRON_SECRET` — required to call `/api/cron/*`

### OAuth redirect URIs (changed in the split)

The provider `redirect_uri`s now point at **this backend**, not the frontend:

- `FACEBOOK_REDIRECT_URI=http://localhost:4000/api/auth/facebook/callback`
- `YOUTUBE_REDIRECT_URI=http://localhost:4000/api/auth/youtube/callback`
- `CANVA_REDIRECT_URI=http://localhost:4000/api/auth/canva/callback` (or leave
  unset to derive from the request origin)

Register these exact URLs in each provider's developer console.

## Cron

The `/api/cron/{publish,verify-posts,insights}` endpoints accept GET or POST and
authenticate with `CRON_SECRET` (either `Authorization: Bearer <secret>` or
`?secret=<secret>`). Point your scheduler (Vercel Cron, GitHub Actions, cron-job.org)
at them:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4000/api/cron/publish
```

## Scripts

- `npm run dev` — watch mode
- `npm run build` — compile to `dist/`
- `npm start` / `npm run start:prod` — run compiled server
