# Architecture — Fal for Miro

Same three-iframe + decoupled-backend pattern as the Runway and ElevenLabs
integrations. This file is the repo-local copy of the board's architecture
diagram and the v1 plan.

## Three iframes

| Iframe   | Entry HTML            | Entry script              | Job |
| -------- | --------------------- | ------------------------- | --- |
| Headless | `frontend/index.html` | `src/headless/index.ts`   | Owns the Miro SDK, listens for `icon:click` (opens the panel) and `RUN_AGENT` messages, runs agents, mutates the board, polls Fal. Keeps running if the panel is closed. |
| Panel    | `frontend/app.html`   | `src/panel/App.tsx`       | UI only. Searchable, model-named home screen. Sends `RUN_AGENT`, renders progress. |
| Modal    | `frontend/modal.html` | `src/modal/App.tsx`       | Fullscreen overlays. Stub. |

Cross-frame contract: `src/shared/messageTypes.ts`. The panel calls
`runAgent()` (`src/panel/communication.ts`) which posts `RUN_AGENT`; the
headless iframe (`src/headless/communications.ts`) dispatches to the registered
agent and broadcasts `AGENT_UPDATE` progress back.

### Embed pages — a fourth, Miro-SDK-free surface

`embed-video.html`, `embed-audio.html`, `embed-3d.html`, `embed-rig.html`,
`embed-panorama.html` (project root, alongside `index.html`/`app.html`/
`modal.html`) are what Miro's embed widget iframes when a generation finishes,
since Miro has no native video/3D/panorama widget — a `<video>`/`<audio>`/
`<model-viewer>`/A-Frame `<a-sky>` page that reads a `?url=` query param and
plays/renders it. Built by `src/lib/api.ts`'s `videoEmbedUrl()` etc.

Unlike the three iframes above, these load **no Miro SDK and talk to no
backend** — every board viewer's browser loads the media straight from Fal's
CDN. That's true even for panorama's WebGL sky texture, which needs a
CORS-clean load: Fal's CDN sends `Access-Control-Allow-Origin` (verified live,
including a canvas-readback check that it isn't tainted), so
`crossorigin="anonymous"` on the `<img>` is enough — no proxy required. That
makes all five genuinely generic: they render identically regardless of which
backend (if any) a given board is using, which matters once boards can each
point at their own self-hosted backend (see below).

## Backend (the part this scaffold fully implements)

A small [Hono](https://hono.dev) app in `backend/src/app.ts`. The `FAL_KEY`
lives only here — the frontend always goes through these routes. Hono's
routes/handlers are runtime-agnostic; `src/node.ts` and `src/worker.ts` are
thin entrypoints that boot the same `app` on Node (`@hono/node-server`) or
Cloudflare Workers respectively — so this backend deploys to a plain Node
host *or* to Workers with no code changes, only a different entrypoint. See
the README's [Deploy your own backend](README.md#deploy-your-own-backend)
for the two paths. Env vars are read per-request via `hono/adapter`'s
`env()` (`process.env` on Node, `c.env`/wrangler bindings on Workers) rather
than once at module load, since Workers only exposes bindings on the request
context.

**Auth:** every `/api/fal/*` route requires an `x-fal-proxy-key` header
matching the deployment's `BACKEND_KEY` secret — checked by middleware in
`app.ts`, fails closed (500) if `BACKEND_KEY` isn't set at all. This exists
because CORS' `Access-Control-Allow-Origin` only stops a *browser* from
reading a disallowed origin's response; it does nothing to stop a direct
`curl`/script call from reaching these routes and spending the deployment's
`FAL_KEY` credits. `/proxy` is exempt from this check (loaded via `<img>`/
`<video>` `src`, which can't attach a custom header); it's instead restricted
to only fetch `fal.media` hostnames, so it can't be abused as a
general-purpose open relay for arbitrary URLs.

| Method | Path                          | What |
| ------ | ----------------------------- | --- |
| GET    | `/healthz`                    | Liveness + whether a key is configured. Unauthenticated. |
| POST   | `/api/fal/run`                | `{ endpointId, input }` → `fal.queue.submit` → `{ requestId }`. Returns immediately. |
| GET    | `/api/fal/status/:requestId`  | `?endpointId=…`. Wraps `fal.queue.status`; on completion also calls `fal.queue.result` and returns `{ status, output[], data }`. |
| POST   | `/api/fal/cancel/:requestId`  | `?endpointId=…`. Wraps `fal.queue.cancel`. |
| GET    | `/api/fal/schema`             | `?endpointId=…`. Proxies Fal's Platform Models API (`expand=openapi-3.0`) → the model's OpenAPI schema. Drives the Option-A generic form. |
| GET    | `/api/fal/models`             | Paginated Fal model catalog with `{ category, tags, displayName, thumbnailUrl }` per endpoint; in-memory 1h TTL cache, `?refresh=1` to bypass. |
| GET    | `/api/fal/balance`            | `account/billing?expand=credits` via `ADMIN_KEY` — powers the credits badge. |
| GET    | `/api/fal/estimate`           | `?endpointId=…&units=…&seconds=…` → unit price × units (or × elapsed seconds for time-billed models) → `{ costUSD }`. |
| GET    | `/proxy`                      | `?url=…`. Streams a remote asset back with CORS + `Range` headers (fetch()-based, so it runs unchanged on Node or Workers) — used by the modal's capture-to-image tools so a `<model-viewer>`/`<video crossorigin>` snapshot doesn't taint the canvas. Unauthenticated, host-restricted (see above). |

`/embed/video`, `/embed/audio`, `/embed/3d`, `/embed/rig`, `/embed/panorama`
**used to be backend routes here** — they're now static pages shipped with the
frontend (see below); this backend no longer serves them at all.

Output extraction is best-effort: `output[]` pulls primary media URLs
(`images[].url`, `video.url`, `audio.url`, …) out of the model-specific result,
while `data` always carries the full untouched payload.

### Frontend ↔ backend: which backend, and how it's authenticated

The frontend build has no backend baked in at build time. `frontend/src/lib/api.ts`
holds a runtime-settable `{ url, key }` pair (`configureBackend()`); every
`/api/fal/*` call sends `key` back as `x-fal-proxy-key`. Each of the three
iframes loads this once at startup via `shared/backendConfig.ts`'s
`loadBackendConfig()`, which reads `getBackendConfig()` — backed by this
**browser's `localStorage`** (key `fal:backendConfig`), not board appData.
That's deliberate: this is a per-person setting, not per-board or per-team —
different people collaborating on the very same board may each be running
their own self-hosted backend with their own `FAL_KEY`, and a board-level
setting would wrongly force them to share one. (`shared/storage.ts`, which
everything board-level like `fal:assetNaming`/`fal:catalogFilter` goes
through, deliberately has no involvement here.) The panel (`panel/App.tsx`)
forces the user into `SettingsScreen` (`forceBackendSetup`) until it's
configured; there's deliberately no public default, so an
installed-but-unconfigured browser fails closed instead of silently spending
whoever's Fal credits happened to be baked into a shared build.
`VITE_API_BASE_URL` / `VITE_BACKEND_KEY` remain as a local-dev-only fallback.

Because reading `localStorage` is synchronous, `loadBackendConfig()` is too —
there's no async gap where the panel doesn't yet know whether a backend is
configured, unlike a board-appData read.

`proxyUrl()` (used by the modal's capture-to-image tools) only uses `url`,
never `key` — it ends up in an `<img>`/`<video>` `src` attribute, which can't
carry a custom header (see the backend's auth section above). The embed URL
builders (`videoEmbedUrl`, …) don't call the backend at all — see "Embed
pages" above — so `backendUrl()`/`backendKey()` don't come into it for them.

## Option A — schema-driven form (the chosen approach)

The catalog (`src/shared/falCatalog.ts`) only says *which* endpoints exist and
their capability. At render time the panel will fetch `/api/fal/schema` for the
selected model and build controls from the live OpenAPI schema:

- **Always-shown** fields = the per-capability `COMMON_ARGS` list (prompt,
  size/aspect ratio, duration, voice, …), bound to the schema's enums/ranges.
- **Advanced** = every other schema field, collapsed, rendered generically.

For image-to-video, the aspect-ratio / resolution controls get a smart default
auto-detected from the selected source image's dimensions (still overridable).

## Built so far

- **`fal_image_gen`** (`src/agents/fal_image_gen/`) — reads the selected
  sticky's text as the prompt, drops a placeholder below it, calls
  `/api/fal/run`, polls `/api/fal/status`, swaps in the result, and persists the
  job in `board.setAppData('fal:activeJobs')`. The finished image is titled
  after the **asset id** detected in the prompt (`ASSET_ID, prompt…` → title
  `ASSET_ID`); the id prefix is stripped from the prompt before it's sent to the
  model, and `resume_jobs` reuses the persisted name.
- **Asset naming** (`shared/assetNaming.ts`) — a configurable regex
  (`fal:assetNaming` in appData, default: the first alphanumeric token before a
  comma) extracts the asset id. The image screen shows it as an editable
  "Asset name" field with a settings disclosure to tune the pattern.
- **`resume_jobs`** — runs on board load from `headless/index.ts`; finalizes or
  re-polls anything left in flight.
- **Board helpers / storage** (`shared/boardHelpers.ts`, `shared/storage.ts`) —
  placeholder placement, frame-aware coordinates, the active-job ledger.
- **Panel** — searchable model home → image-gen screen (sticky auto-fill,
  image-size, count) + active-jobs tray.
- **References → video** (`panel/screens/ReferenceToVideoScreen.tsx`) — select
  references on the board (or a frame that contains them) and weave them into one
  shot. Two modes (`isReferenceToVideo` routes; `isBlendReference` picks the
  mode), both driven by `fal_video_gen`'s `references` payload:
  - **Seedance 2.0** (`bytedance/seedance-2.0/reference-to-video`) — images +
    video embeds; `bindSeedanceReferences` orders each modality by first mention
    and rewrites board titles into `@Image1` / `@Video1` tokens → `image_urls` /
    `video_urls`. Caps 9 images + 3 videos. Handles people.
  - **Veo 3.1** (`fal-ai/veo3.1/reference-to-video`, `blend: true`) — images only,
    passed as-is into `image_urls` and blended ("ingredients"); no `@token`
    rewrite, no video refs. Cap 3 images. Blocks identifiable people.
- **Reference images** (`shared/referenceBinding.ts`) — the schema tells us a
  model's image input (`pickReferenceField`: `image_urls` / `image_url` /
  `reference_image_url`, never a mask). The agent collects images connected to
  the sticky, resolves each to a data URI, orders them by first mention of their
  board title in the prompt, and adapts the prompt per model: a "Reference image
  N is NAME." legend for natural-language models, `@Image{n}` for Kling,
  `<|image_{n}|>` for OmniGen v1. Single-input models get the first image only.
  Data URIs go straight to Fal (no upload step yet).

## What's NOT built yet (next milestones)

- **The generic schema form + Advanced section** — currently the image screen
  uses a small hardcoded `image_size` list; swap it for controls built from
  `/api/fal/schema`.
- **`fal_video_gen`** (with source-image aspect/resolution auto-detect) and
  **`fal_audio_gen` / music**.
- **Reference images** — `getConnectedReferenceImages` is ported but not yet fed
  into image-to-image model inputs.
