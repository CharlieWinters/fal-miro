# Porting to Higgsfield and Runway

Research notes + a recommended shape for making this app multi-provider.
Written 2026-09-04 against the live Higgsfield and Runway OpenAPI specs
(both fetched and analysed — see "Sources" at the bottom).

Nothing here is implemented. This is the thinking, so the decisions are
made before the refactor rather than during it.

---

## TL;DR

1. **This is not a port, it's an adapter seam.** Both providers are strictly
   *narrower* than fal, and roughly 85% of Higgsfield's catalog is third-party
   models fal already carries. Framing it as "port the app to Higgsfield" spends
   the effort in the wrong place.
2. **Both providers expose a full static OpenAPI document** covering every
   model. That's *better* than fal for the generic schema form — one fetch, no
   per-model round trip. Runway even uses `oneOf` + `discriminator: model`, so
   per-model ratio/duration/max-refs enums come for free.
3. **`runway-miro/frontend/src/shared/runwayCatalog.ts` is now dead.** Every
   ratio table, duration allowlist and max-refs number in it — painstakingly
   reverse-engineered from Runway 400 errors — is in the spec. Don't port that
   file; delete the concept, the same way commit `d36e9d6` did for fal.
4. **The one thing that genuinely breaks the architecture is output URL
   expiry.** Runway: 24–48 h. Higgsfield: ≥7 days. fal: effectively permanent.
   The board holds embed URLs that resolve in *every viewer's browser at view
   time*, so boards rot. This needs backend asset storage, which collides with
   the current "everyone deploys their own stateless backend" design.
5. **Recommended order:** adapter seam (fal only) → Runway → asset re-hosting →
   Higgsfield. Rationale in [Sequencing](#sequencing).

---

## What's actually coupled to fal

Five seams, in descending order of how much they hurt:

| # | Seam | Where |
| - | ---- | ----- |
| 1 | **Assets** — data-URI inputs accepted; outputs are permanent `fal.media` URLs; `/proxy` host-allowlisted to `fal.media` | `boardHelpers.ts`, `backend/src/app.ts`, embed pages |
| 2 | **Model identity** — everything keys off one opaque `endpointId` string, assumed to be a `provider/model/task` path | everywhere (~40 files) |
| 3 | **Schema** — `GET /api/fal/schema?endpointId=` → one model's OpenAPI → generic form | `shared/schema.ts`, `GenericModelScreen.tsx` |
| 4 | **Discovery** — `GET /api/fal/models` → ~1,500 endpoints with `category`, `tags`, `thumbnail_url` | `shared/falCatalog.ts` |
| 5 | **Transport + pricing** — submit/poll/cancel, `/estimate`, `/balance` | `lib/api.ts`, `backend/src/app.ts`, `shared/cost.ts` |

Seam 5 is nearly free — all three providers are submit → id → poll. Seams 3 and
4 are *easier* on the new providers, not harder. Seam 2 is mechanical. Seam 1 is
the project.

---

## Side-by-side

| | **fal** | **Higgsfield** | **Runway** |
| --- | --- | --- | --- |
| Base | `fal.run` / `api.fal.ai/v1` | `api.higgsfield.ai` | `api.dev.runwayml.com` |
| Auth | `Authorization: Key <k>` | `Authorization: Key <id>:<secret>` | `Authorization: Bearer <k>` |
| Submit | `POST /{endpointId}` (queue) | `POST /{endpoint path}` | `POST /v1/{task}` — **model is a body field** |
| Poll | `status(endpointId, requestId)` | `GET /requests/{id}/status` | `GET /v1/tasks/{id}` |
| Cancel | `queue.cancel` | `POST /requests/{id}/cancel` | `DELETE /v1/tasks/{id}` |
| Endpoint count | ~1,500 (live) | **48** (static spec) | **49 paths**, ~40 (task × model) generation combos |
| Per-model schema | live, one fetch per model | one doc, all models | one doc, `oneOf` + `discriminator: model` |
| Status values | `IN_QUEUE` / `IN_PROGRESS` / `COMPLETED` | `queued` / `in_progress` / `completed` / `failed` / `nsfw` / `canceled` | `PENDING` / `THROTTLED` / `RUNNING` / `SUCCEEDED` / `FAILED` / `CANCELLED` |
| Output shape | `images[].url`, `video.url`, `audio.url`, `audios[].url` | **identical keys** | flat `output: string[]` |
| Image input | data URI OK | **hosted URL only** — presigned upload required | data URI (≤5 MB), `https://`, or `runway://` |
| Cost | unit price × units, computed after the fact | `POST /estimate/{model}` — pre-flight, credits + USD | `estimatedCost.credits` on every poll, free |
| Balance | `/account/billing` (needs `ADMIN_KEY`) | not documented | `GET /v1/organization` → `creditBalance` |
| Thumbnails / categories / tags | yes | no (only OpenAPI `tags` = family) | no (only OpenAPI `tags`) |
| **Output lifetime** | **effectively permanent** | **≥ 7 days** | **24–48 h**, refreshable by re-fetching the task |

Two pleasant surprises worth calling out:

- **Higgsfield's output keys are byte-identical to fal's.** `extractOutputUrls()`
  in `shared/falOutput.ts` / `backend/src/lib/output.ts` works on Higgsfield
  responses *verbatim*. Runway needs a two-line adapter (flat array).
- **Both status endpoints are keyed by request id alone** — no `endpointId`
  query param. The app always passes one, which is harmless; the adapter just
  ignores it.

---

## Problem 1: output URL expiry (the only architectural one)

### Why it bites here specifically

Look at how assets land on the board (`shared/boardHelpers.ts`):

- **Images** → `miro.board.createImage({ url })`. The provider URL is read once,
  at creation.
- **Video, audio, 3D, panorama, rig** → `createEmbedAtPosition({ url:
  'embed-video.html?url=<providerUrl>' })`. Per `ARCHITECTURE.md`, the embed
  pages deliberately load **no Miro SDK and talk to no backend** — every board
  viewer's browser fetches the media straight from the provider CDN, *at view
  time, forever*.

That second row is the whole problem. On Runway a board's videos go dark in a
day or two. On Higgsfield, a week. The design that makes the embed pages elegant
— "genuinely generic, render the same regardless of which backend" — is exactly
what makes them fragile against an expiring URL.

### The second face of it: `getImageUrl`

`getImageUrl()` in `shared/boardHelpers.ts` prefers the **hosted** URL over
`getDataUrl()`:

```ts
const FAL_FETCHABLE_HOST_RE = /^https:\/\/([^/]*\.)?(fal\.media|fal\.run|…)\//i;
if (item.url && FAL_FETCHABLE_HOST_RE.test(item.url)) return item.url;
```

That's a sound optimisation on fal (pristine image, tiny payload, avoids the
multi-MB base64 body that trips Veo first/last-frame). On an expiring provider
it's **actively harmful**: chaining a week-old board image into image-to-video
hands the model a dead URL. On those providers `getImageUrl` has to invert and
prefer `getDataUrl()` — i.e. behave like `getImagePixelRef` — and eat the
payload-size problem the current comment warns about.

> ⚠️ **Test this first.** Whether `item.url` on a Miro image item retains the
> *source* URL or a Miro-hosted copy decides how bad this is. The regex above
> matching in practice implies Miro keeps the source URL on the item, even
> though Miro does store the bytes (which is why `getDataUrl()` works at all).
> If that's right, images survive visually but break as *inputs*. One 10-minute
> experiment settles it and it changes the scope of Phase 3.

### Options

**(a) Re-host on completion.** Backend gains a storage binding (R2 on Workers /
S3 or disk on Node), downloads the finished asset, serves it from `/asset/:id`.
~80 lines. Turns the backend from a stateless proxy into a stateful one, which
is a real change to the "each person deploys their own backend, config in
per-browser `localStorage`" story — but it's the only thing that makes video
durable. Only needed for non-image outputs, since Miro takes a copy of images.

**(b) Refresh on view.** The embed page asks the backend to re-resolve the task
and hand back a fresh URL. Works for Runway (the spec explicitly says "fetch the
task again to get fresh URLs"); does **not** work for Higgsfield past 7 days.
Also breaks the embed pages' best property — no SDK, no backend, no auth.

**(c) Accept it.** Images durable, video ephemeral, panel says so. Honest for a
demo. Bad for the AI-movie-planning use case this app exists for, which is
entirely about boards that persist.

**Recommendation: (a)**, gated behind an adapter capability flag
(`outputsExpire: boolean`). fal keeps the zero-storage path it has today and
pays nothing for the feature.

---

## Problem 2: what *is* a model

fal and Higgsfield: a model is a path. Runway: a model is a **(task path, model
enum) pair** — `POST /v1/text_to_video` with `{ model: 'gen4.5', … }`.

The app keys everything off a single `endpointId` string: the `fal:activeJobs`
appData ledger, per-item metadata, favourites, `PipelineAppDef` step
definitions, the catalog filter.

**Cheapest correct fix: make `endpointId` opaque and adapter-owned.** The Runway
adapter encodes the pair into one string — `runway:text_to_video#gen4.5` — and
parses it back on submit. Nothing else in the app has to learn that Runway is
shaped differently. What *does* need per-adapter implementations is the handful
of functions that currently parse the string by splitting on `/`:

`providerOf()`, `familyOf()`, `taskOf()`, `categoryOf()`, `capabilityForCategory()`
— all in `shared/falCatalog.ts`.

---

## Problem 3: catalog and schema become static

This is the part that gets *easier*.

`falCatalog.ts` opens with "There is no hand-maintained model list here — the
catalog IS fal's." For the new providers the catalog **is the OpenAPI document**:
one fetch, cached, and it carries the input schema for every model at the same
time. No `/schema` round trip per model at all.

Deriving the browse hierarchy from a spec:

| Field | fal | Higgsfield | Runway |
| --- | --- | --- | --- |
| capability | `FAL_CATEGORY_MAP[category]` | path segment (`…/text-to-video` → video) | task path (`/v1/text_to_video` → video) |
| family | derived from endpoint id | OpenAPI tag (`["Veo3.1"]`, `["Dop"]`, `["Soul"]`) | model enum value |
| task | derived | last path segment | task path |
| provider | first path segment | first path segment | always `runway` — or use the model's real vendor |
| thumbnail | `thumbnail_url` | **none** | **none** |

Thumbnails are the only genuine loss. The home screen falls back to
`CapabilityIcon.tsx`, which already exists.

`shared/schema.ts` (the OpenAPI → form-controls parser) should port with modest
changes — both specs use plain JSON Schema with `enum`, `default`, `title`,
`minimum`/`maximum`, `format: uri`. Runway's variants need one extra step:
resolve `oneOf` by the `model` discriminator before parsing.

### Two input-shape wrinkles

- **Higgsfield `nano-banana`** takes `input_images: [{ type: 'image_url',
  image_url: '…' }]` — a *wrapped* object, not fal's flat `image_urls: string[]`.
  `referenceBinding.ts`'s `pickReferenceField` needs a third shape.
- **Higgsfield rejects data URIs outright** (`format: uri, minLength: 3`).
  Everything image-shaped needs `POST /files/generate-upload-url` → `PUT` to the
  presigned URL → pass `public_url`. Note this endpoint is documented but **not
  in the OpenAPI spec** (nor is `POST /estimate/{model}`) — the spec covers
  generation + status + cancel only.

---

## Problem 4: capability coverage — the honest gap

| Capability | fal | Higgsfield | Runway |
| --- | :-: | :-: | :-: |
| image | ✅ | ✅ soul, nano-banana, reve, flux-kontext | ✅ 10 models |
| video | ✅ | ✅ 30+ endpoints | ✅ 16 i2v / 15 t2v / 8 v2v |
| audio, music, sound fx | ✅ | ❌ | ✅ TTS, STS, sound fx, dubbing, isolation, voices |
| 3D / rig / bone pose | ✅ | ❌ | ❌ |
| panorama | ✅ | ❌ | ❌ |
| segmentation (SAM 3) | ✅ | ❌ | ❌ |
| ffmpeg merge | ✅ | ❌ | ❌ |
| upscale | ✅ | ❌ | ✅ image + video |
| avatars / lipsync / realtime | partial | ❌ | ✅ large surface |
| **camera-motion presets** | ❌ | ✅ **DoP motions** | ❌ |
| server-side recipes / workflows | ~ Apps | ❌ | ✅ 7 recipes + published workflows |

So roughly half this app's bespoke screens — `RiggingScreen`, `BonePoseScreen`,
`RigPoseScreen`, `ThreeDViewerToImageScreen`, `PanoramaToImageScreen`,
`mask-creator`, `MergeVideosScreen`, `MergeAudioVideoScreen`,
`SceneBuilderScreen` — have **nothing behind them** on either new provider.

Don't port them. Let the catalog hide them: `modelsByCapability()` returns empty
→ the home-screen tile doesn't render. That's already how the code behaves, so
the work is just making the derived catalog honest about what's missing.

---

## Things worth *adding*, not just porting

Each provider has something fal doesn't. These are the actual reasons to do this
work — and they should shape where the effort goes:

- **Higgsfield DoP motions.** `motions: [{ id: <uuid>, strength: 0–1 }]`, max 2,
  on `dop/lite|standard|turbo`. A library of named camera moves (crash zoom,
  dolly, bullet time…). This is Higgsfield's real differentiator and it maps
  perfectly onto the movie-planning use case: pick a shot on the board, pick a
  camera move. **Caveat:** there is no motion-preset discovery endpoint in the
  spec, so this is the one hand-maintained list that's genuinely unavoidable.
  Worth a bespoke screen.
- **Runway published workflows.** `GET /v1/workflows` + `POST /v1/workflows/{id}`
  is the server-side equivalent of this app's "Apps ▸ Flavor 1" pipelines.
  Listing an org's published workflows as apps is a nicer story than
  hand-coding pipelines in `src/apps/`.
- **Runway `estimatedCost`** arrives free on every poll, and `cost.credits` is
  the *final actual* charge on a terminal task. That replaces the whole
  `/estimate` + `shared/cost.ts` guesswork with a real number.
- **Runway voices and avatars** — a capability class this app doesn't model at
  all.

### The uncomfortable question

**Could you just stay on fal?** Higgsfield's 48 endpoints break down as:

| Vendor | Endpoints |
| --- | --: |
| minimax (hailuo) | 10 |
| kling-video | 7 |
| veo3.1 | 7 |
| reve | 5 |
| bytedance/seedance | 4 |
| sora-2 | 4 |
| wan-25 | 2 |
| nano-banana | 1 |
| flux-pro/kontext | 1 |
| **higgsfield-ai (soul, dop, popcorn)** | **7** |

**41 of 48 are third-party models fal also resells.** Only 7 — Soul, DoP,
Popcorn — are Higgsfield originals. Runway's ratio is better but the same shape:
its own Gen-4.x family, Aleph, Act-Two, Avatars, Muse, alongside a long list of
Veo / Seedance / Hailuo / Wan / Gemini / GPT / Grok / Seedream / ElevenLabs
resells.

Worth saying out loud so the effort lands on the parts that *aren't* already
one `endpointId` away on fal.

---

## Recommended shape

One adapter interface, one file per provider, behind the existing `api` object
in `lib/api.ts` (which already has a two-mode `backend` / `client` split to
build on):

```ts
interface ProviderAdapter {
  id: 'fal' | 'higgsfield' | 'runway';

  submit(endpointId: string, input: Record<string, unknown>): Promise<{ requestId: string }>;
  status(endpointId: string, requestId: string): Promise<StatusResponse>; // normalized enum + output[]
  cancel(endpointId: string, requestId: string): Promise<void>;

  listModels(): Promise<ModelMeta[]>;        // live API | derived from the static spec
  schema(endpointId: string): Promise<JSONSchema>; // per-model fetch | a slice of one spec

  /** data URI as-is, or upload-and-return-a-public-url. */
  resolveInput(field: string, image: ImageRef): Promise<string>;

  balance?(): Promise<number>;
  estimate?(endpointId: string, input: unknown): Promise<number>;

  capabilities: {
    outputsExpire: boolean;   // → re-host non-image outputs
    acceptsDataUris: boolean; // → skip the upload step
    hasThumbnails: boolean;   // → home-screen tile fallback
  };
}
```

Then:

- `configureConnection()` gains a `provider` field; `SettingsScreen` gets a
  provider picker. It's already per-browser `localStorage`, which is the right
  granularity — two people on the same board can point at different providers.
- `falCatalog.ts` → `catalog.ts`; `FAL_CATEGORY_MAP` becomes
  `adapter.categoryFor()`.
- `/proxy`'s host allowlist becomes `adapter.allowedProxyHosts`.

### On renaming

~40 files mention "fal", but nearly all of it is *naming*, not logic: the
`fal:activeJobs` / `fal:assetNaming` appData keys, `fal_image_gen` agent ids, the
`x-fal-proxy-key` header.

**Don't big-bang rename.** Those appData keys exist on real boards today —
renaming them is a data migration for zero user-visible benefit. Rename the
TypeScript identifiers; leave the wire format and storage keys alone. They're
opaque strings and nobody sees them.

---

## Sequencing

**Phase 1 — adapter seam, fal only.** Extract `ProviderAdapter`, make
`endpointId` opaque, move `providerOf`/`familyOf`/`taskOf`/`categoryOf` behind
it. No behaviour change; fully verifiable against today's app. *This is where
all the risk lives* — do it with one provider so nothing is chasing two moving
targets at once.

**Phase 2 — Runway.** The better second provider: it accepts data URIs (no
upload plumbing), gives cost and balance for free, and the discriminated-union
spec drops straight into the generic form. Costs: the (task, model) identity
change and living with 24–48 h URLs for a while.

**Phase 3 — asset re-hosting**, gated on `outputsExpire`. Required before Runway
video is usable on a board anyone comes back to. This is where the stateless
per-user backend design has to give.

**Phase 4 — Higgsfield.** Adds the presigned-upload step and the DoP motion
picker. Its 7-day window is more forgiving than Runway's, so it benefits from
Phase 3 already existing.

Explicitly **not** in scope: porting the 3D / rig / panorama / segmentation /
merge screens. They have no counterpart on either provider.

---

## Sources

- Higgsfield OpenAPI 2.0.0 — `https://docs.higgsfield.ai/docs/openapi.json`
  (168 KB, 50 paths: 48 generation + status + cancel)
- Higgsfield docs — [file uploads](https://docs.higgsfield.ai/docs/concepts/file-uploads),
  [billing and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention),
  [FAQ](https://docs.higgsfield.ai/docs/help/faq)
- Runway OpenAPI 3.1.0 (`2024-11-06`) — `https://docs.dev.runwayml.com/openapi.json`
  (633 KB, 49 paths)
- Prior art in this workspace: `../runway-miro/` — a working first-generation
  Runway integration and this app's direct ancestor. Its `ARCHITECTURE.md` is
  worth reading; its `shared/runwayCatalog.ts` is superseded by the spec.
