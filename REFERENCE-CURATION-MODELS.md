# Fal models for reference curation & merging

For the mood-board workflow: collect reference images on the Miro board → merge /
restyle / combine them into new generations. The models that fit are the
**multi-image edit** models (they accept several `image_urls`), which the app
already supports via the connect-references + naming flow. Verified on fal.ai,
Jun 2026 — confirm exact endpoint ids / reference limits on each model's page.

## At a glance

| Model | Fal endpoint | Max refs | Best for | ~Price |
| --- | --- | --- | --- | --- |
| Nano Banana (edit) | `fal-ai/nano-banana/edit` | ~14 | Fast semantic multi-image merges — great default (already wired) | low |
| Nano Banana Pro | `fal-ai/gemini-3-pro-image-preview/edit` | ~8–14 | Deepest compositional reasoning, best text rendering — hero merges | ~$0.15 |
| Seedream 4.5 | `fal-ai/bytedance/seedream/v4.5/edit` | ~14 | Best detail/identity preservation in reference edits, up to 4K | ~$0.04 |
| GPT-Image 1.5 (edit) | `fal-ai/gpt-image-1.5/edit` | multi | Complex multi-source blending + mask inpainting | ~$0.009 |
| FLUX.2 [pro] edit | `fal-ai/flux-2-pro/edit` (dev: `fal-ai/flux-2/edit`) | ~9 | Production compositing, no masks/config | ~$0.03/MP |
| FLUX.1 Kontext [max] multi | `fal-ai/flux-pro/kontext/max/multi` | multi | Iterative character + product consistency | ~$0.04 |

## Notes per model

- **Nano Banana (edit)** — Gemini 2.5 Flash Image. Fast, cheap, strong semantic
  understanding ("put the jacket from image 1 on the person in image 2").
  Already in the app — the sensible default for everyday merging.
- **Nano Banana Pro** — Gemini 3 Pro Image. Premium quality, best spatial
  reasoning across many references and legible text. Use for final/hero outputs.
- **Seedream 4.5** — ByteDance. Standout for *preserving* details from source
  references (faces, products, textures) while restyling — the "keep this,
  change that" mood-board move. High resolution, low cost.
- **GPT-Image 1.5 (edit)** — OpenAI. The "power tool" for blending several
  distinct sources, and the only one here with mask-based inpainting. Cheapest.
- **FLUX.2 [pro]/[dev] edit** — Black Forest Labs. Reliable natural-language
  compositing for batch work; dev variant cheaper for iteration.
- **FLUX.1 Kontext [max] multi** — Best when iterating on the *same* subject
  across edits and needing it to stay consistent.

## Recommendation for this use case

- **Default:** Nano Banana (edit) — already supported, fast, cheap.
- **Hero / quality:** Nano Banana Pro, or Seedream 4.5 when preserving reference
  detail matters most.
- **Heavy multi-source blends:** GPT-Image 1.5.
- **Iterative character consistency:** Kontext [max] multi.

All are multi-image (`image_urls`) models, so they work with the app's existing
connect-references + name-binding flow. Next step if wanted: add these endpoints
to `falCatalog.ts` so they appear in the searchable model list.

---

*Sources: fal.ai model pages & guides — Nano Banana Pro / Nano Banana edit,
Seedream 4.5, GPT-Image 1.5 edit, FLUX.2 [pro]/[dev] edit, FLUX.1 Kontext [max]
multi; fal.ai "best image editing tools 2026" and "Nano Banana vs Seedream".*
