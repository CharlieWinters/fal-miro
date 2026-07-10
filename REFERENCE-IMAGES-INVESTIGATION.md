# Investigation — reference images on Fal (the Miro "connect references" pattern)

**Question (from Seán):** In the Runway app you connect reference images to a
sticky with lines, and they're sent to Runway along with the sticky's text. Does
the same premise work for most Fal models? This is a core reason the Miro
integration beats the standalone Fal playground, so worth confirming before video.

**Short answer:** Yes — for the large class of Fal models that take image inputs,
and the pattern maps cleanly onto our already schema-driven form. The deciding
factor is **not the model category but whether the schema exposes an image
input** — and many *text-to-image* models do, for style/structure conditioning.
So the gate is purely schema-driven.

---

## 1. Which models accept references — category is the wrong lens

Reference images aren't limited to "image-to-image / edit". Several **text-to-image**
models take them too, for conditioning rather than editing:

- **Redux** remixers — `fal-ai/flux/dev/redux`, `…/schnell/redux`,
  `…/flux-pro/v1.1/redux`, etc. — text-driven, take a single `image_url` as a
  style/subject reference.
- **FLUX General** (`fal-ai/flux-general`) — a text-to-image endpoint that takes
  `reference_image_url` (+ `reference_strength`) for reference-only guidance, plus
  IP-Adapter and ControlNet references (see nested conventions below).
- IP-Adapter / ControlNet / subject-reference variants generally.

| Takes reference image? | Examples |
| --- | --- |
| **No** — prompt only | base T2I like `fal-ai/flux/dev` (plain text-to-image) |
| **Yes** (edit / i2i) | FLUX dev i2i, FLUX Kontext, Nano Banana edit, GPT-Image edit, upscalers |
| **Yes** (T2I + reference) | Redux endpoints, FLUX General, IP-Adapter / ControlNet models |
| **Yes** (i2v source frame) | Seedance i2v, etc. |

**Correct rule:** offer / send references whenever the selected model's schema has
an image input — regardless of whether it's labelled text-to-image. The schema is
the source of truth.

## 2. Parameter conventions (consistent enough to automate)

| Convention | Meaning | Models |
| --- | --- | --- |
| `image_url` (string) | one input/reference image | FLUX dev i2i, FLUX Kontext, Flow-Edit, Redux, Seedance i2v |
| `image_urls` (array) | several reference images | Nano Banana edit, GPT-Image 2 / 1.5 edit |
| `reference_image_url` (string) | reference-only guidance | FLUX General |
| `mask_image_url` (string) | localized/masked edit | GPT-Image, others |
| **nested** `ip_adapters[].image_url`, `controlnets[].image_url` | conditioning refs inside object-arrays | FLUX General, ControlNet/IP-Adapter models |

Two branches to handle. The **top-level** scalar/array fields (`image_url`,
`image_urls`, `reference_image_url`) are easy and cover most cases:

- **`image_urls`** → send *all* images connected to the sticky.
- single (`image_url` / `reference_image_url`) → send the first connected image
  (or let the user pick which).

The **nested** ones (`ip_adapters[].image_url`, `controlnets[].image_url`) are the
catch our *flat* parser currently misses — it classifies those object-arrays as
opaque `json`. They're advanced (each carries `scale` / `control_method` / strength
knobs), so for v1 they stay in the Advanced JSON section; auto-fill targets the
top-level fields only. Detecting and auto-populating nested image refs is a
follow-up.

> Note: a Fal **snake_case deprecation** exists, but only in the *Vercel AI SDK*
> wrapper (`@ai-sdk/fal`). We call Fal directly via `@fal-ai/client`, where
> `image_url` / `image_urls` remain the correct, current names. No impact on us.

## 3. How images get to Fal — three options

A Fal image input accepts: (a) a **Base64 data URI**, (b) a **public URL**, or
(c) a URL from **`fal.storage.upload`**. Fal recommends uploading large files
rather than inlining Base64 (data URIs hurt request performance at size).

Miro gives us a Base64 data URI per image via `getDataUrl()` (already used in
`boardHelpers.getImageUrl`). So:

- **Fastest path (works today):** pass the data URI straight through — same as the
  Runway app does. Good enough to ship.
- **Recommended:** add a backend step that uploads incoming data URIs via
  `fal.storage.upload` and substitutes the returned URL. Keeps payloads small,
  keeps the `FAL_KEY` server-side, and is more reliable for big board images.

## 4. The differentiator — why this matters

Connecting images spatially on the canvas and having them flow into the
generation with the sticky's prompt is exactly what the standalone Fal playground
can't do. Confirming it generalizes means the integration's core value holds
across most of Fal's image (and image-to-video) catalog — not just one model.

---

## Recommendation / proposed plan

1. **Extend the schema parser** to record whether a top-level image field is
   single (`image_url`, `reference_image_url`) or array (`image_urls`). Continue
   to treat nested `ip_adapters[]` / `controlnets[]` arrays as Advanced JSON.
2. **Auto-collect connected images** in `fal_image_gen` (we already have
   `getConnectedReferenceImages` + `getImageUrl`): resolve each connected image to
   a data URI and populate the model's top-level image field — all for
   `image_urls`, first for single fields. Manual URL entry stays as override.
3. **Backend upload (recommended, second pass):** add `/api/fal/upload` (or do it
   inline in `/run`) that pushes data URIs to `fal.storage.upload` and swaps in
   the URL before submitting.
4. Surface it in the UI: when the selected model has an image input, show
   "N reference image(s) connected" so the user knows they'll be sent.
5. Follow-ups (not v1): `mask_image_url`, per-image picking for single-input
   models, and **nested** `ip_adapters[].image_url` / `controlnets[].image_url`
   auto-population.

This slots in before video and makes image-to-image / edit models genuinely
useful from the board.

---

*Sources: Fal model API pages — FLUX.1 dev image-to-image, FLUX Kontext,
Nano Banana edit, GPT-Image 2 / 1.5 edit, Flow-Edit, Professional Photo; Fal docs
on file inputs (Base64 / public URL / `fal.storage.upload`).*
