# Investigation — naming/tagging references in the prompt (Fal vs Runway's @tag)

**Question:** Runway lets you title a connected image (e.g. WOMAN, OUTFIT) and
write "Put WOMAN in the OUTFIT"; the app injects `@WOMAN` / `@OUTFIT` and Runway
binds each tag to its reference image. Does Fal have a common pattern for naming
references in the prompt?

**Short answer:** No single universal pattern. Fal's de-facto convention is
**positional / natural-language** (image order in `image_urls` = "first image",
"second image"). Two models offer explicit **numbered** tokens. **Name-based**
tagging like `@WOMAN` isn't native anywhere — but we can preserve the Miro UX by
translating it at send-time.

---

## What Fal actually supports

### 1. Positional + natural language — the dominant pattern

Multi-image models (Nano Banana edit / 2 / Pro, GPT-Image edit, OmniGen v2,
FLUX.2 edit, Kling) reference inputs by their **order in the `image_urls`
array**. The model grounds them semantically from the prose:

- "Using Reference Image 1 (the model) and Reference Image 2 (the silk gown),
  generate … the model wearing the gown."
- "Add the bird from image 1 to the desk in image 2."

No special syntax — relies on the model's multimodal understanding, so this
"works" across most multi-image models. Names appear only as plain description
("the woman", "the dress"), not as bound tags.

### 2. Explicit numbered tokens (closest analogs to @tag)

| Model | Syntax | Example |
| --- | --- | --- |
| **Kling O1 Image** | `@Image1`, `@Image2` (up to 10) | "put @Image1 in @Image2" |
| **OmniGen v1** | inline `<|image_1|>` | "a photo of `<|image_1|>` wearing `<|image_2|>`" |

Both are **numbered, not named**, and model-specific. OmniGen v2 dropped the
token for plain "image 1 / image 2".

### 3. No name-based tagging

Nothing on Fal binds a free-form name (`@WOMAN`) to a specific reference the way
Runway's tags do. The binding is always positional (array order) or, at most,
positional-with-a-token.

---

## How to preserve the Miro UX (proposed)

Keep the powerful part — *name your images on the board, refer to them by name in
the prompt* — and translate to whatever the chosen model understands. A small
**reference-binding layer** in `fal_image_gen`:

1. **Read titles** of the sticky-connected images (we already have them via
   `getConnectedReferenceImages`; re-add the `title` it used to carry).
2. **Order the `image_urls` array by first mention** of each title in the prompt
   (case-insensitive whole-word). Unreferenced images go last. This makes
   "image 1 / image 2" line up with the order the user described.
3. **Adapt the prompt per model**, via a tiny per-endpoint strategy:
   - **Default (natural-language models):** leave the names as prose and prepend
     a concise legend so ordering is unambiguous —
     `"Reference image 1 is WOMAN. Reference image 2 is OUTFIT. <user prompt>"`.
   - **Kling O1:** replace each name with `@Image{n}` (WOMAN→`@Image1`).
   - **OmniGen v1:** replace each name with `<|image_{n}|>`.
   - Pick the strategy from the `endpointId` (a small map; default otherwise).
4. **Don't force `@`** on models that don't understand it — a stray `@` can
   confuse a natural-language model. Names stay as words unless the model is
   Kling/OmniGen.

### Why this is the right shape

- It mirrors Runway's "title + reference in prose" workflow so the board UX is
  consistent across our integrations.
- It degrades gracefully: even with zero special syntax, ordering + the injected
  legend gives the model what it needs.
- It's per-model without bloating the catalog — just a strategy lookup.

### Caveats

- It's a **heuristic translation**, not native binding — quality depends on the
  model's grounding (strong on Nano Banana / GPT-Image, variable elsewhere).
- Single-input models (`image_url`) can't take multiple named refs; the legend
  approach only applies to `image_urls` (array) models.
- This is a **polish layer on top of the reference-sending already built** — that
  works today without it. Worth doing once basic references are validated.

---

## Recommendation

Ship and test the basic reference-sending first (done). Then add the
reference-binding layer above as a focused follow-up — default natural-language
strategy first (covers Nano Banana / GPT-Image, the marquee cases), Kling O1 /
OmniGen token strategies only if we add those models.

---

*Sources: Fal model pages & guides — Nano Banana 2 / Pro edit, GPT-Image edit,
OmniGen v1 & v2, Kling O1 Image, FLUX.2 edit, USO, Minimax subject-reference;
Fal "How to use Nano Banana 2" prompting guide.*
