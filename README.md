# Fal for Miro

A Miro board app for generating images, video, 3D models, and audio with
[Fal](https://fal.ai) models — pick a model, generate from a prompt or
selected board content, and the result drops back onto the board. Reference
images bind by name across models, video/3D/audio outputs become playable
embeds, and generated items track their lineage back to their sources.

> An independent, unofficial project. Not affiliated with, endorsed by, or
> supported by Miro or fal.ai. "Miro" and "fal" and the provider names and
> logos in the model picker belong to their respective owners — see
> [NOTICE](NOTICE).

## Install

**[Install "Fal for Miro" on your Miro team](https://miro.com/app-install/?response_type=code&client_id=3458764674362323749&redirect_uri=%2Fapp-install%2Fconfirm%2F)**

Once installed, open the app from a board's toolbar icon. On first open it'll
ask you to connect it to Fal — two ways to do that:

- **Use your Fal key in this browser** (default) — nothing to deploy. Paste a
  Fal API key from [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys)
  into Settings and you're generating. The key is stored in your browser's
  `localStorage`, unscoped and not spend-limited — fine for solo use on your
  own device, not for a shared machine. Settings spells out the tradeoff.
- **Deploy your own backend** — your Fal key never touches the browser, and
  unlocks the full feature set (credit balance, some board-capture tools).
  See [Deploy your own backend](#deploy-your-own-backend) below.

Either way, the connection is saved per-browser, not per-board — different
people on the same board can each be running their own backend (or their own
key) without conflict.

## What it does

- **Image generation** — e.g. Nano Banana, FLUX, Seedream. Reference images
  connected on the board are bound by name into the prompt (adapted per
  model's expected reference syntax); a model with no image input just uses
  the prompt.
- **Video generation** — e.g. Veo, Seedance — image-to-video, first+last
  frame, and references-to-video. Two-frame models get a dedicated
  start/end screen.
- **Segmentation** — e.g. SAM, text-prompted object extraction → cutout on
  the board.
- **3D & panorama** — e.g. Hunyuan3D, TripoSR (image-to-3D → orbit-able
  `.glb` viewer embed), Hunyuan World (image-to-panorama → 360° photosphere
  embed), Meshy (rig + animate for posable characters).
- **Audio** — e.g. ThinkSound, MMAudio, Hunyuan Foley (video → generated
  soundtrack), plus FFmpeg-backed merge utilities (merge videos, merge audio
  + video).
- **Full model catalog** — beyond the models above, the app syncs Fal's live
  model list and merges it in automatically, with a local cache so returning
  visits load instantly instead of waiting on a fresh sync.
- **Cost & lineage** — a credits badge, an estimated cost per generated
  asset, and "trace lineage" to walk a result back to its source/reference
  items.

## Deploy your own backend

The backend is a small [Hono](https://hono.dev) app (`backend/src/app.ts`)
with your `FAL_KEY` as its only real dependency — deploy it wherever you
like. The frontend build is shared/public and has **no default backend baked
in**; each board points itself at your deployment via the panel's Settings
screen, not a build-time env var.

Every deployment also needs a **`BACKEND_KEY`** — any random string you
generate yourself. The frontend sends it back as the `x-fal-proxy-key`
header on every `/api/fal/*` call; without a match, the backend rejects the
request. This is what stops anyone who finds your deployed URL from spending
your `FAL_KEY` credits — CORS alone doesn't (it only stops a *browser*
reading a disallowed origin's response, not a direct request from reaching
the backend at all).

### Cloudflare Workers (recommended — free, zero idle cost)

```bash
cd backend
npm install
wrangler login                       # one-time
wrangler secret put FAL_KEY          # paste your key
wrangler secret put ADMIN_KEY        # optional — powers the credits badge + raises /models rate limits
openssl rand -hex 32                 # generate a BACKEND_KEY — copy the output, you'll also paste it
                                      # into the panel's Settings screen later (see below)
wrangler secret put BACKEND_KEY      # paste the value you just generated
npm run deploy:worker
```

`wrangler.toml` holds the non-secret config (`ALLOWED_ORIGINS`, etc.) — edit
`ALLOWED_ORIGINS` to your deployed frontend's origin before deploying. For
local Workers dev, copy `.dev.vars.example` to `.dev.vars` (gitignored, never
committed) and run `npm run dev:worker`.

### Node (Docker / Fly / Railway / any VM)

Same `npm install` + `npm run dev` / `start` as local dev below — any host
that can run a long-lived Node process works unchanged. Set `FAL_KEY`,
`ADMIN_KEY`, `BACKEND_KEY`, `ALLOWED_ORIGINS`, and `PORT` as environment
variables on that host.

### Either way — point your board at it

Open the panel in Miro → Settings (gear icon) → "Deploy your own backend" →
paste your backend's URL and the `BACKEND_KEY` you set.

For local dev only, `frontend/.env`'s `VITE_API_BASE_URL` / `VITE_BACKEND_KEY`
act as a fallback so you don't have to click through Settings every time you
restart the dev server — these are never used in the public build.

## Layout

```
fal-miro/
  backend/           Hono proxy — FAL_KEY lives here only, deploy it anywhere
    src/app.ts       Routes/logic, runtime-agnostic (/healthz, /api/fal/*, /proxy)
    src/node.ts      Node entrypoint (npm run dev / start)
    src/worker.ts    Cloudflare Workers entrypoint (npm run dev:worker / deploy:worker)
  docs/              design notes and investigations, kept for the reasoning
  frontend/          Vite + React, three iframes (headless / panel / modal)
    embed-*.html     Static video/audio/3d/rig/panorama viewers — no backend needed
    src/shared/      falCatalog (model catalog + capabilities), messageTypes, storage
    src/lib/api.ts   Fal client — routes to your backend or straight to Fal,
                     depending on connection mode
    src/apps/        one folder per pipeline app — sealed compartments
    src/agents/      one folder per generation worker — sealed compartments
```

The `apps/`, `agents/` and `screens/` folders are deliberately self-contained
and deliberately repeat themselves; `shared/` and `lib/` are the parts that
don't. A boundary linter enforces the split in CI.
[CONTRIBUTING.md](CONTRIBUTING.md) explains why, and why the duplication is
the point.

See `ARCHITECTURE.md` for the three-iframe (headless / panel / modal) pattern
in more detail.

## Run it locally (dev)

Backend (Node — see [Deploy your own backend](#deploy-your-own-backend) for
Cloudflare Workers):

```bash
cd backend
cp .env.example .env        # then set FAL_KEY=...
npm install
npm run dev                 # http://localhost:8789
npm run typecheck           # tsc --noEmit
```

Frontend:

```bash
cd frontend
cp .env.example .env        # VITE_API_BASE_URL=http://localhost:8789, VITE_BACKEND_KEY=<your local BACKEND_KEY>
npm install
npm run dev                 # http://localhost:5175
npm run lint                # type-check + boundary rules (see CONTRIBUTING.md)
```

To load a local build in Miro, create an app, paste `app-manifest.yaml`, and
point `sdkUri` at your hosted (or tunnelled) `index.html`.

## Quick backend smoke test

```bash
curl localhost:8789/healthz
# {"ok":true,"hasKey":true}

# Fetch a model's schema (drives the generated form):
curl "localhost:8789/api/fal/schema?endpointId=fal-ai/flux/dev" | head

# Kick off a generation:
curl -X POST localhost:8789/api/fal/run \
  -H 'Content-Type: application/json' \
  -d '{"endpointId":"fal-ai/flux/dev","input":{"prompt":"a red bicycle"}}'
# {"requestId":"…","endpointId":"fal-ai/flux/dev","status":"QUEUED"}

curl "localhost:8789/api/fal/status/<requestId>?endpointId=fal-ai/flux/dev"
```

## Contributing

Issues and pull requests welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first — the architecture is compartmented on
purpose and the section on shared code will save you a rejected PR.

Found a security issue? Please report it privately —
see [SECURITY.md](SECURITY.md). If you're deploying this somewhere other people
can reach, read that file's threat model first: `BACKEND_KEY` is a gate, not a
secret.

## Licence and credit

[Apache-2.0](LICENSE) © Sean Winters.

**Please use this.** Fork it, change it, ship it, sell it — that's what the
licence is for, and no permission is needed.

The one ask: keep the attribution. Apache-2.0 section 4(d) requires that if you
redistribute this or a derivative, the notice in [NOTICE](NOTICE) travels with
it — in your own NOTICE file, in your documentation, or in a credits screen in
your product. Any of the three is fine.

If you build something interesting on top, I'd genuinely like to hear about it.

Provider logos and the CDN-loaded viewer libraries are not covered by this
licence and belong to their owners — also in [NOTICE](NOTICE).
