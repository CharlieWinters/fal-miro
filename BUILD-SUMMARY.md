# Fal for Miro — what's been done

A summary of the work so far, from planning through the first build pass.
Dated 4 Jun 2026.

---

## 1. Planning (on the Miro board)

Parsed your Talktracks and grounded the plan in the existing Runway and
ElevenLabs codebases. Produced, on the *Miro <> Fal.ai integration* board:

- **Integration Plan (v1)** — reuse the proven three-iframe + decoupled-backend
  architecture; v1 scoped to Fal's **Models API only** (no serverless/compute).
- **Form-strategy decision** — diagram + doc comparing **Option A** (generic
  schema-driven form) vs **Option B** (hand-tuned templates). You chose **A**.
- **Common Model Arguments spec** — the "always-shown" fields per capability,
  with everything else collapsed under Advanced. Includes the agreed
  image-to-video aspect/resolution **auto-detect from the selected image**.

The key unlock confirmed during planning: Fal exposes a full **OpenAPI 3.0
schema per model endpoint** via its Platform Models API
(`GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0`), so the
form can be built from live schemas instead of hardcoding each model.

---

## 2. Build pass — scaffold + backend

New project at `fal-miro/`, alongside the Runway and ElevenLabs apps (untouched).

### Backend — complete and runnable (`backend/src/server.js`)

Express proxy using `@fal-ai/client`. The `FAL_KEY` lives only here.

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness + whether a key is set. |
| `POST /api/fal/run` | `queue.submit` → returns `requestId` immediately (non-blocking). |
| `GET /api/fal/status/:id` | `queue.status`; on completion also `queue.result` → `{ status, output[], data }`. |
| `POST /api/fal/cancel/:id` | `queue.cancel`. |
| `GET /api/fal/schema` | Proxies the Models API → a model's OpenAPI schema (drives the Option-A form). |

Output extraction is best-effort: `output[]` pulls primary media URLs out of
each model's result shape, while `data` keeps the full untouched payload.

### Frontend — compiling skeleton

- Three iframes wired: headless (`index.html`), panel (`app.html`), modal
  (`modal.html`), with the `RUN_AGENT` / `AGENT_UPDATE` cross-frame plumbing.
- Typed Fal API client (`src/lib/api.ts`).
- Catalog stub (`src/shared/falCatalog.ts`) with a starter model list and the
  agreed `COMMON_ARGS` tiers.
- Empty agent registry — agents are the next milestone.
- Panel renders a **searchable, model-named home screen** as a placeholder.

### Ports — no collisions with the other two apps

| App | Backend | Frontend |
| --- | --- | --- |
| Runway | 8787 | 5173 |
| ElevenLabs | 8788 | 5174 |
| **Fal** | **8789** | **5175** |

---

## 3. Verification — and its limits

- Backend passes Node syntax checks; all config/JSON valid.
- Every `.ts` file passes Node 22's type-strip parse.
- **Not done:** full `tsc` type-check. The sandbox's npm registry is locked
  down (403 on `@mirohq/websdk-types` and `typescript`), so dependencies can't
  be installed here. **Run `npm install && npm run lint` locally** to confirm
  types before building on top.

---

## 4. Next milestones

1. Port `fal_image_gen` from the Runway app's `runway_image_gen`
   (sticky → placeholder → run → poll → swap-in → persist job).
2. Copy `boardHelpers.ts` + `storage.ts` from the Runway app.
3. Build the generic schema-driven form (always-shown + Advanced).
4. `fal_video_gen` with the source-image aspect/resolution auto-detect.
5. The catalog-scaffolding skill that registers a new `endpoint_id` from its schema.

See `README.md` for dev/run commands and `ARCHITECTURE.md` for how the pieces
fit together.

---

## Open housekeeping

Three duplicate "Form Strategy" docs remain on the board (a retry glitch),
retitled **"⚠️ DUPLICATE — SAFE TO DELETE"**. The Miro tools can't delete docs,
so they need a manual delete when convenient.
