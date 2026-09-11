# Architecture — Fal for Miro

Three iframes plus a decoupled backend. This file is the repo-local copy of
the architecture notes; where it and the code disagree, the code wins and this
file needs a fix.

## Three iframes

| Iframe   | Entry HTML            | Entry script              | Job |
| -------- | --------------------- | ------------------------- | --- |
| Headless | `frontend/index.html` | `src/headless/index.ts`   | Owns the Miro SDK, listens for `icon:click` (opens the panel) and `RUN_AGENT` messages, runs agents, mutates the board, polls Fal. Keeps running if the panel is closed. |
| Panel    | `frontend/app.html`   | `src/panel/App.tsx`       | UI only. Searchable, model-named home screen. Sends `RUN_AGENT`, renders progress. |
| Modal    | `frontend/modal.html` | `src/modal/App.tsx`       | Fullscreen overlays: the six capture tools (3D Viewer, Video Player, Panorama, Rig Viewer, Pose Character, Scene Builder), routed by `?tool=`. |

Cross-frame contract: `src/shared/messageTypes.ts`. The panel calls
`runAgent()` (`src/panel/communication.ts`) which posts `RUN_AGENT`; the
headless iframe (`src/headless/communications.ts`) dispatches to the registered
agent and broadcasts `AGENT_UPDATE` progress back.

### Embed pages — a fourth, Miro-SDK-free surface

`embed-video.html`, `embed-audio.html`, `embed-3d.html`, `embed-rig.html`,
`embed-panorama.html`, `embed-motion.html` (project root, alongside
`index.html`/`app.html`/`modal.html`) are what Miro's embed widget iframes when
a generation finishes, since Miro has no native video/3D/panorama widget — a
`<video>`/`<audio>`/`<model-viewer>`/A-Frame `<a-sky>` page that reads a
`?url=` query param and plays/renders it. Built by `src/lib/api.ts`'s
`videoEmbedUrl()` etc. The motion page is the one with bundled code
(`src/embed/motion.ts`, three.js + FBXLoader), because nothing loads FBX
natively; a boundary rule keeps `src/embed/` free of everything but three.js.

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
holds a runtime-settable connection (`configureConnection()`): either a
backend `{ url, key }` pair or, in client mode, a Fal key used directly from the
browser. In backend mode every
`/api/fal/*` call sends `key` back as `x-fal-proxy-key`. Each of the three
iframes loads this once at startup via `shared/backendConfig.ts`'s
`loadBackendConfig()`, which reads `getConnectionConfig()` — backed by this
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
pages" above — so the configured backend doesn't come into it for them.

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

## Apps (curated layer)

Browse ▸ Apps sits above raw model access (Category/Provider — unchanged,
still the full catalog via the generic schema form). Per the board
brainstorm, each app is deliberately a one-off: its own screen, its own
orchestration, no shared "app schema" imposed across them. What *is* shared
is the same low-level plumbing every other screen already uses — run/poll,
board placement, lineage.

There are three flavors.

### Flavor 1 — pipeline apps (`src/apps/<app-id>/` + `agents/run_pipeline`)

Chains one or more Fal calls with a hardcoded/templated prompt, each step's
output feeding the next step's input. Each app gets its own folder under
`src/apps/`, mirroring how `src/agents/<id>/` works for headless agents —
adding an app never means editing another app's file, only adding a folder
and one aggregator line. Recipe for a new one:

1. Create `src/apps/<app-id>/index.ts`, exporting `appDef: PipelineAppDef`
   (types + helpers from `shared/pipelineAppTypes.ts`): an ordered `steps[]`,
   each a `{ endpointId, label, buildInput, ratioFromItemId? }`.
   - `buildInput({ fixedInputs, priorOutputs })` builds that step's Fal
     input. `fixedInputs` holds **board item ids only**, never resolved image
     data — it's persisted to board appData (~30 KB cap) between steps, so
     resolve ids to real image data *inside* `buildInput`, right when that
     step needs it (see `resolveImageUrls`). Passing a resolved base64 image
     through `fixedInputs` will silently come back as a `'[image]'`
     placeholder string on the next step — this bit us once already.
   - `ratioFromItemId` (optional): which fixedInput's board shape should
     drive this step's placeholder size and, when the model has a matching
     field, the actual generation request (e.g. size a sketch-to-image step
     to the sketch, a try-on step to the model photo — not to whichever
     image happens to be listed first).
   - `boardLayout: boolean` on the app itself — does it lay each step's
     output out on the board (a visual trail, each item lineage-linked to
     the last), or keep everything inside its own panel screen? Either way
     the run is resumable across a closed/reopened board; `boardLayout` only
     decides *placement*, never durability.
2. Add `src/apps/<app-id>/Screen.tsx` (see `apps/sketch-to-tryon/Screen.tsx`)
   that collects the fixed inputs — board item ids, via "select on board →
   Use/Add selected image(s)" — and kicks off the run:
   `startAgentJob({ agentId: 'run_pipeline', payload: { appId, fixedInputs } })`.
   It can import `appDef` from its own folder's `index.ts` directly (e.g. to
   list "Models used") rather than going through the registry.
3. Register the one new app in `shared/pipelineApps.ts` (import `appDef`,
   add it to the `APPS` array), add a tile for it in `HomeScreen.tsx`'s Apps
   section (`browseMode === 'apps'`), calling `onOpenApp('your-app-id')`, and
   register the screen in `App.tsx`'s `openApp === 'your-app-id'` branch. Those
   three files are the only ones a new app touches outside its own folder.

The one piece of shared "magic" is `shared/pipelineRunner.ts`'s
`advancePipelineForJob` — called from exactly two places: the live loop in
`agents/run_pipeline` (foreground), and `resume_jobs`'s boot sweep (the board
was closed mid-run). Both do "read persisted state → do one thing → persist
→ return," so a reload can't behave differently than the live path would
have. New apps never need to touch this file.

**Known limitation — URL outputs only.** `advancePipelineForJob` reads a
step's result via `outputUrl = status.output?.[0]` (from `extractOutputUrls`,
which pulls hosted URLs/`.url` fields out of the result). A step whose useful
output is *text* (an LLM/VQA answer, not an image/video URL) currently comes
back with `outputUrl` undefined and gets treated as if it failed. Wiring up a
genuinely text-output step needs `outputUrl`/`extractOutputUrls` extended
first — not yet done.

### Flavor 2 — interactive tools (e.g. Mask Creator)

Not every app is a model pipeline — some are canvas/editor UIs that call Fal
once (or never). Mask Creator (`apps/mask-creator/Screen.tsx`) is a panel
screen opened from the Apps tab via `onOpenApp('mask-creator')`; it owns its
whole interaction loop (canvas painting, click handling) and reuses only image
resolution (`boardHelpers.ts`), the shared poller (`shared/pollStatus.ts`) and
the same `api.run` everything else uses. The older capture tools
(3D/video/panorama/rig/pose/scene in `panel/screens/`) predate the Apps concept
and open fullscreen in `modal.html` via `miro.board.ui.openModal({ url:
'modal.html?tool=<id>&itemId=<id>', fullscreen: true })`, routed in
`src/modal/App.tsx`; they stay where they are.

A new Flavor-2 app still gets its own folder under `src/apps/<app-id>/` for
the same reason Flavor 1 does — one folder per app — even though it has no
`index.ts`/`PipelineAppDef`; it is wired up by `HomeScreen.tsx` and
`App.tsx`, not through `pipelineApps.ts`.

### Flavor 3 — no-model apps (local compositing, asset libraries)

Apps that produce board content with **no Fal call at all** — they spend no
credits. Two are built: Pattern Fill (local image compositing) and Add Video
from URL (references an existing video as a board embed).

An earlier Flavor-3 app, Fashion Sketches (a PLM-style asset library shipping
technical flats as bundled PNGs), was cut before the repo went public. It is
preserved on the `wip/apps-snapshot` branch if the pattern is ever wanted
again — it demonstrated the useful half of this flavor, which is that a
panel-only app can drop rasterized content on the board without any backend
at all.

Wiring for a Flavor-3 app is the same two lines as any app: a tile in
`HomeScreen.tsx`'s Apps section calling `onOpenApp('<app-id>')`, and the
matching branch in `App.tsx`. Nothing in `pipelineApps.ts` — there's no
pipeline to register.


#### Pattern Fill (`apps/pattern-fill/`)

Colours or patterns a garment flat — ported from the standalone
**pattern-fill-miro-app** repo (`agents/pattern_fill_agent/`), which shares
this app's three-iframe ancestry.

What the port changed, and why:

- **The model call is gone.** The original's only backend dependency was the
  *mask*: a Nova Canvas `BackgroundRemoval` round trip to AWS Bedrock per
  fill. For technical flats — dark line art on a white ground — the mask is
  already implicit in the drawing, so `autoMask.ts` flood-fills inwards from
  the image border through background pixels; the ink stops it, and "not
  reached" is exactly the garment silhouette. Local, exact, ~5 ms. Where an
  outline doesn't close (loose sunglasses temples, a flat cropped at the
  canvas edge) the fill leaks and the mask comes back near-empty — the panel
  detects that from the coverage figure and says so, and will read a mask
  image off the board instead. fal-miro's **Create Mask** app (SAM 3) is what
  makes one, so the manual path costs a model call only when it's needed.
- **Five passes became one.** The original ran five sequential full-image
  passes over separate canvases (transparent layer → pattern layer → applied
  mask → 3-step composite → keep-mask). The layers only ever combine
  per-pixel, so `fill.ts`'s `composite()` is a single pass with the same
  formulas. Writing the algebra out surfaced that the original's "composite
  step 3" is a **no-op whenever the fill layer is opaque** — which it always
  is for a solid colour — since step 2's alpha is already 255; it's kept for
  patterns that carry real transparency, where it still bites.
- **Multiply mode is the whole trick.** It multiplies the flat's own greys
  into the fill instead of painting over them, which is what keeps seams,
  topstitching, ribbing and shading readable. Turning it off returns a flat
  silhouette — the toggle is there to make that visible, not because it's a
  reasonable default.
- **Not ported:** the mask paint editor and the pattern crop editor (two
  modal editors), and `VirtualTryOn`. Create Mask covers mask production;
  tile size covers most of what crop was for. Try-on isn't pattern fill —
  Sketch to Try-On already owns that step.

**Getting pixels off the board: `getImagePixelRef`, not `getImageRef`.**
`getImageUrl` (behind `getImageRef`) prefers the hosted fal.media URL,
because every other caller sends that URL *to Fal*, where a URL beats a
multi-MB base64 body. Local pixel work wants the exact opposite: a
cross-origin image taints the canvas — or, with `crossOrigin="anonymous"`
and no `Access-Control-Allow-Origin` from that host, refuses to load at all.
So `getImagePixelRef` (`boardHelpers.ts`) tries `getDataUrl()` first: a
`data:` URI is same-origin by definition, so it needs no CORS, no `/proxy`,
and **no backend** — which is what makes the app's "no credits, no backend"
claim actually true. Pattern Fill shipped with the wrong resolver at first
and failed on a fal.media-hosted garment with a dead-proxy error; the two
resolvers now say in their doc comments which job each is for.
`loadPixelImage` still falls back to a direct cross-origin load and then to
`/proxy`, for images Miro won't hand over bytes for — that's the only path
here that touches a backend, and it reports *that* rather than echoing a URL
when both fail.

#### Add Video from URL (`apps/add-video-from-url/`)

Puts a video that already exists somewhere onto the board, so the video
screens — Sound, Merge Videos, Merge Audio + Video, Video → Image — can take
it as input.

The app exists because of a gap outside this repo: **Miro has no video
upload**, not in the Web SDK and not in the REST API. The only way video
reaches a board is the embed + `embed-video.html` player trick that generated
output already uses, so this app reuses it verbatim — it calls the same
`videoEmbedUrl()` a finished generation calls. That's what makes the result
indistinguishable downstream: `unwrapVideoEmbedUrl()` reads the URL straight
back out, and every consumer screen treats it as a Fal video.

Two consequences worth knowing:

- **The video is referenced, not copied.** Whoever hosts it keeps serving it,
  to two different clients: the viewer's browser (to play the embed) and Fal's
  servers (to read `video_url`). A URL behind a cookie or a signed session
  will play for you and fail for Fal.
- **Length is the usual disappointment.** Most Fal video-input models cap well
  below a full-length source clip, so the screen probes duration in the
  browser and warns before anything is spent. Frame capture is exempt — it
  reads one frame at any length.

`videoUrl.ts` holds the parsing, kept apart from the screen because that's
where the hostile input is: a pasted string ends up in an iframe `src`, so
anything that isn't `http(s)` is refused there rather than filtered
downstream, and one of our own player URLs pasted back in is unwrapped instead
of wrapped twice.

It also resolves an `archive.org/details/<id>` page URL — an HTML page, not a
video — to a playable file, picking the **smallest** playable file in the
item. Those items routinely carry a preservation master beside a small
derivative of the same content (a 1.6 GB MPEG4 next to a 55 MB h.264), and the
derivative is the one a board wants; anyone needing the master can paste its
download URL directly. The item metadata endpoint sends
`Access-Control-Allow-Origin: *`, so that lookup needs no backend of ours and
the app stays Flavor 3.


## What's NOT built yet (next milestones)

- **Text-output pipeline steps** — see the "URL outputs only" limitation above.
- **A dedicated audio agent** — text-to-audio and music run through
  `fal_generic`; the schema form and `fal_video_gen` and reference images that
  used to sit on this list are built.
