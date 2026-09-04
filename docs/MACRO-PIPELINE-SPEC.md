# Spec — Lineage → Macro (replayable pipelines)

**Status:** Draft / parked for later. Idea: turn an asset's recorded lineage
into a reusable, parameterised pipeline (e.g. "text → rigged 3D character") that
re-runs the same models automatically from a new input.

> Also intended for the project Miro board
> (`https://miro.com/app/board/uXjVH_mheZg=/`) — blocked at time of writing by the
> board's content-security classification; post there once MCP access is granted.

## The core reframe

Lineage is already a **DAG of `(model, inputs, parent-wiring)`** — every
generated item stores its `endpointId`, the `input` it ran with, its `parents`,
and estimated `costUSD` (see `shared/storage.ts` `GenSettings`). A **macro** is
that DAG **replayed with the leaf inputs swapped** (a new prompt), where each
intermediate input is **wired from the previous step's output** instead of
hardcoded.

## What we already have (makes this feasible)

- **Recipe is reconstructable** — walking `parents` back from a final asset
  gives the ordered chain of endpoints + args (already done for "Trace lineage"
  in `panel/SelectionTools.tsx`).
- **Output → input wiring is inferable** — per-capability reference-field logic
  (`shared/schema.ts` `pickReferenceField`) already knows which input field
  takes the upstream asset (`input_image_url` for image→3D, `model_url` for rig,
  …).
- **Executor exists** — each step is a `/run` + poll we already do; a runner
  just chains them.
- **Projected cost for free** — sum per-step estimates (`/api/fal/estimate`) and
  show the macro total *before* running.

## What it takes to build

1. **Extract + templatize** a selected asset's lineage into a recipe: keep each
   step's endpoint + non-media args (prompt, size, strength, animation IDs);
   replace media inputs with a "bind to previous output" marker; expose the
   **root prompt** as the macro parameter.
2. **Macro-runner / orchestrator agent** — runs steps in order, extracts each
   output URL, feeds it into the next step's reference field, drops the final
   asset (and optionally intermediates) on the board.
3. **Save / run UI** — "Save this lineage as a macro" (name → stored in board
   app-data); "Run macro" (new prompt → executes → projected cost shown).

## Honest catches

- **Manual steps aren't in the lineage.** 3D-viewer→image, pose, panorama-crop
  are human-framed captures (no `/run` call), so they carry no recipe entry
  today. Pure "text → final" can only automate **model** steps unless we also
  **record manual-op params** (camera angle, chosen pose, crop) to replay them.
- **Branching flows** (background + character + object → combine) are a DAG, not
  a line — replayable, but more complex. Start linear.
- **Slimmed metadata** drops media/data-URIs (fine — intermediates re-wire from
  live outputs), but confirm non-media args (prompt, etc.) are preserved, not
  truncated (`slimSettings` in `shared/storage.ts`).

## Suggested v1

Linear, model-only chains (e.g. **text → image → 3D → rig**): select a final
asset → **Save as macro** → **Run with a new prompt** → re-runs the same models
end-to-end, shows projected cost, drops the result.

## Later

- Branching DAGs (the full golden-flow diagram as a one-click macro).
- Record manual-op parameters (camera / pose / crop) so human-framed steps
  replay too.
- Seed exposure for reproducibility; per-step overrides; resumable runs on
  failure.
