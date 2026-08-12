# Fal for Miro

A Miro web-SDK integration for [Fal](https://fal.ai) model generation (image /
video / audio / music), built on the same architecture as the Runway and
ElevenLabs integrations. See `ARCHITECTURE.md`.

> **Status: image + video generation (golden-demo build).** Schema-driven
> Option-A form; image generation (text-to-image, image-to-image, multi-reference
> with name binding) and **Veo 3.1 image-to-video** (drops a playable embed on the
> board). Catalog trimmed to Nano Banana + Veo 3.1; the Flux family and other
> models are kept behind `SHOW_EXPERIMENTAL` in `falCatalog.ts`. Next: SAM
> segmentation, then Veo first+last-frame.

## Layout

```
fal-miro/
  backend/           Hono proxy — FAL_KEY lives here only, deploy it anywhere
    src/app.ts       Routes/logic, runtime-agnostic (/healthz, /api/fal/*, /proxy)
    src/node.ts      Node entrypoint (npm run dev / start)
    src/worker.ts    Cloudflare Workers entrypoint (npm run dev:worker / deploy:worker)
  frontend/          Vite + React, three iframes (headless / panel / modal)
    embed-*.html     Static video/audio/3d/rig/panorama viewers — no backend needed
    src/shared/      messageTypes, falCatalog (stub), agentRegistry (empty)
    src/lib/api.ts   Fal backend client
```

## Run it (dev)

Backend (Node — see [Deploy your own backend](#deploy-your-own-backend) for Cloudflare Workers):

```bash
cd backend
cp .env.example .env        # then set FAL_KEY=...
npm install
npm run dev                 # http://localhost:8789
npm run lint                 # tsc --noEmit (type-check)
```

Frontend:

```bash
cd frontend
cp .env.example .env        # VITE_API_BASE_URL=http://localhost:8789, VITE_BACKEND_KEY=<your local BACKEND_KEY>
npm install
npm run dev                 # http://localhost:5175
npm run lint                # tsc --noEmit (type-check)
```

To load in Miro, create an app, paste `app-manifest.yaml`, and point `sdkUri`
at your hosted (or tunnelled) `index.html`.

## Quick backend smoke test

```bash
curl localhost:8789/healthz
# {"ok":true,"hasKey":true}

# Fetch a model's schema (drives the Option-A form):
curl "localhost:8789/api/fal/schema?endpointId=fal-ai/flux/dev" | head

# Kick off a generation:
curl -X POST localhost:8789/api/fal/run \
  -H 'Content-Type: application/json' \
  -d '{"endpointId":"fal-ai/flux/dev","input":{"prompt":"a red bicycle"}}'
# {"requestId":"…","endpointId":"fal-ai/flux/dev","status":"QUEUED"}

curl "localhost:8789/api/fal/status/<requestId>?endpointId=fal-ai/flux/dev"
```

## Deploy your own backend

The backend is a small [Hono](https://hono.dev) app (`backend/src/app.ts`) with your `FAL_KEY` as its only real dependency — deploy it wherever you like. The frontend build is shared/public and has **no default backend baked in** — each board points itself at your deployment via the panel's Settings screen (see below), not a build-time env var.

Every deployment also needs a **`BACKEND_KEY`** — any random string you generate yourself (e.g. `openssl rand -hex 32`). The frontend sends it back as the `x-fal-proxy-key` header on every `/api/fal/*` call; without a match, the backend rejects the request. This is what stops anyone who finds your deployed URL from spending your `FAL_KEY` credits — CORS alone doesn't (it only stops a *browser* reading a disallowed origin's response, not a direct request from reaching the backend at all).

### Cloudflare Workers (recommended — free, zero idle cost)

```bash
cd backend
npm install
wrangler login                       # one-time
wrangler secret put FAL_KEY          # paste your key
wrangler secret put ADMIN_KEY        # optional — powers the credits badge + raises /models rate limits
wrangler secret put BACKEND_KEY      # any random string — required
npm run deploy:worker
```

`wrangler.toml` holds the non-secret config (`ALLOWED_ORIGINS`, etc.) — edit `ALLOWED_ORIGINS` to your deployed frontend's origin before deploying. For local Workers dev, copy `.dev.vars.example` to `.dev.vars` (gitignored, never committed) and run `npm run dev:worker`.

### Node (Docker / Fly / Railway / any VM)

Same `npm install` + `npm run dev` / `start` as local dev above — any host that can run a long-lived Node process works unchanged. Set `FAL_KEY`, `ADMIN_KEY`, `BACKEND_KEY`, `ALLOWED_ORIGINS`, and `PORT` as environment variables on that host.

### Either way — point your board at it

Open the panel in Miro → it'll force you into **Settings** until a backend is configured (or use the gear icon later to change it) → paste your backend's URL and the `BACKEND_KEY` you set. This is saved in **your own browser's `localStorage`**, not the board — it's per-person, not per-board or per-team. Different people working on the very same board may each be running their own backend with their own `FAL_KEY`, and that's expected; there's no shared/global default for anyone who installs the app.

For local dev only, `frontend/.env`'s `VITE_API_BASE_URL` / `VITE_BACKEND_KEY` act as a fallback so you don't have to click through Settings every time you restart the dev server — these are never used in the public build.

## Done so far

- Backend proxy (`/run`, `/status`, `/cancel`, `/schema`, `/healthz`).
- `boardHelpers.ts` + `storage.ts` (active-job ledger under `fal:`).
- **`fal_image_gen`** — sticky prompt → placeholder → `/api/fal/run` → poll
  `/status` → swap in result → persist + resume-on-load.
- **Generic schema-driven form (Option A)** — `shared/schema.ts` parses a
  model's OpenAPI into typed fields; `panel/SchemaForm.tsx` renders them split
  into always-shown (`COMMON_ARGS`) + collapsed Advanced. The image screen fetches
  `/api/fal/schema` and builds controls from it (prompt-only fallback if it fails).
- Panel: searchable model home screen → schema-driven image screen + active-jobs tray.
- **Image-primary mode** — when a model's image input is *required* (image-to-image
  / edit), the image is the subject: select one on the board (Runway-style), the
  screen confirms "✓ using selected image", the prompt auto-fills from a sticky
  connected to that image, and the raw URL field is hidden. A "What gets sent"
  preview shows the source, references, prompt, size and `strength`.
- **Reference images** — images connected to the sticky are sent as the model's
  image input (all for `image_urls`, first for single fields), resolved to data
  URIs. `referenceBinding.ts` orders them by first mention of their board title in
  the prompt and adapts the prompt per model (legend for natural-language models;
  `@Image{n}` for Kling; `<|image_{n}|>` for OmniGen v1). Models with no image
  input ignore connections. See `REFERENCE-IMAGES-INVESTIGATION.md` and
  `REFERENCE-TAGGING-INVESTIGATION.md`.

## Golden-demo capabilities — all built

- **Nano Banana (edit) / Pro** — references-to-image, image edit, sketch-to-real,
  virtual try-on (all prompts over the same edit model).
- **Text-to-image generators** — Nano Banana · Generate, Nano Banana Pro ·
  Generate, FLUX.2 [pro] / [dev]. No source image, so the **selected sticky
  populates the prompt** (text-primary flow).
- **SAM 3 · Extract object** — text-prompted segmentation → cutout on the board.
- **Veo 3.1 · Image to Video** and **· First+Last Frame** — playable embeds.
  Best quality + native audio, but Gemini **blocks identifiable people** — use for
  objects / scenes (car, cockpit, environment, transitions).
- **Seedance 1.5 Pro · Image to Video / Start+End (people)** — the people-capable
  video for the human scenes Veo refuses. (Seedance 2.0 is also added but, like
  Veo, blocks real-people likenesses — use it for non-people shots.) Two-frame routing is driven by a
  `twoFrame` catalog flag; `pickFrameFields` resolves first/last from the schema
  (`first_frame_url`/`last_frame_url` for Veo, `image_url`/`end_image_url` for Seedance).

## Cost & lineage

- **Credits badge** (top-right) — `GET /api/fal/balance` (`account/billing?expand=credits`).
- **Per-asset cost** — each generated item's metadata gets an estimated `costUSD`
  (`/api/fal/estimate` = unit price × billing units; best-effort, no per-call cost
  from Fal). Select assets on the board → the home screen shows the est. total.
- **Lineage** — generated items store their `parents` (source / reference / sticky
  ids). "Trace lineage" walks that chain back to the original source assets.

## Next

1. **Dry-run the 3-scene "Vibes of Freedom" ad** end-to-end to surface rough edges.
2. Optional: sketch-to-real / virtual-try-on presets over Nano Banana.
3. Deferred: image-to-3D; `fal_audio_gen` / music; the catalog-scaffolding skill.
