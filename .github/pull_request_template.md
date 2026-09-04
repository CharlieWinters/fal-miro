## What changed

<!-- One or two sentences. What behaviour is different after this? -->

## Why

<!-- The problem, not the patch. -->

## Checks

- [ ] `cd frontend && npm run lint && npm run build`
- [ ] `cd backend && npm run typecheck`
- [ ] No secrets, keys or internal URLs added

## Architecture

<!-- Delete any that don't apply. -->

- [ ] This change stays inside one compartment (`apps/`, `agents/`, `screens/`).
- [ ] **This adds to or changes `shared/` or `lib/`** — the hull. Say why it has
      to be shared, and why it's a *contract* rather than duplicated behaviour.
      See CONTRIBUTING.md.
- [ ] **This adds Miro Web SDK calls to a hot path.** Say roughly how many per
      interaction and why the event payload wasn't enough.
