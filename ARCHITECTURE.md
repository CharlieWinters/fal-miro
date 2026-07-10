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

## Backend (the part this scaffold fully implements)

A small Express server in `backend/src/server.js`. The `FAL_KEY` lives only
here — the frontend always goes through these routes.

| Method | Path                          | What |
| ------ | ----------------------------- | --- |
| GET    | `/healthz`                    | Liveness + whether a key is configured. |
| POST   | `/api/fal/run`                | `{ endpointId, input }` → `fal.queue.submit` → `{ requestId }`. Returns immediately. |
| GET    | `/api/fal/status/:requestId`  | `?endpointId=…`. Wraps `fal.queue.status`; on completion also calls `fal.queue.result` and returns `{ status, output[], data }`. |
| POST   | `/api/fal/cancel/:requestId`  | `?endpointId=…`. Wraps `fal.queue.cancel`. |
| GET    | `/api/fal/schema`             | `?endpointId=…`. Proxies Fal's Platform Models API (`expand=openapi-3.0`) → the model's OpenAPI schema. Drives the Option-A generic form. |

Output extraction is best-effort: `output[]` pulls primary media URLs
(`images[].url`, `video.url`, `audio.url`, …) out of the model-specific result,
while `data` always carries the full untouched payload.

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
