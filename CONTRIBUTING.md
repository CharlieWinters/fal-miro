# Contributing

Thanks for taking a look. This is a personal project released so others can
learn from it and build on it — issues and pull requests are welcome, and so is
forking it and going your own way. It is independent and unofficial: not
affiliated with, endorsed by, or supported by Miro or fal.ai, and nothing here
speaks for either company.

## Getting set up

You need Node 22.12 or newer (there is an `.nvmrc`), a [fal.ai](https://fal.ai)
API key, and a Miro account with developer access to a team.

```bash
# backend
cd backend && npm ci && cp .env.example .env   # fill in FAL_KEY + BACKEND_KEY (the frontend must be given the same BACKEND_KEY)
npm run dev

# frontend, in another shell
cd frontend && npm ci && npm run dev
```

Then create a Miro app pointing at `http://localhost:5175`. `README.md` has the
long version.

Before you open a PR:

```bash
cd frontend && npm run lint && npm test && npm run build
cd backend  && npm run typecheck && npm test
```

CI runs exactly these. `npm run lint` is typecheck plus the boundary rules;
`npm run lint:boundaries` runs just the boundary check described below, and
`npm run test:watch` is the usual loop while writing tests.

### What the tests cover, and what they don't

Vitest, no coverage threshold. The suite is aimed at the hull rather than
spread evenly: `falCatalog`'s routing rules, `assetNaming`'s user-supplied
regular expressions, `cost`'s timing parser and the prompt assembler. Those are
the modules where a mistake is silent — a wrong routing rule doesn't throw, it
just sends a model to the wrong screen or drops it out of the browser
altogether.

Two of those rules had been wrong in exactly that way before the tests existed,
so several cases are written directly against the real endpoint names that
broke. When you add a rule to `ENDPOINT_OVERRIDES`, add the endpoint it is meant
to catch **and** a sibling it must not — `whenCategory` exists because name
patterns alone are far too blunt across a 1,500-model catalog.

Not covered: anything needing a live board. `useBasket`'s stateful half, the
agents, and the screens are all verified by hand. If you are changing those,
say in the PR how you tested them.

## The architecture, and why it looks over-duplicated

**This is the part worth reading before you change anything.**

The layout is deliberately compartmented — the author calls it the *titanic
structure*. Each app, agent and screen is a sealed compartment. An AI coding
assistant (or a human in a hurry) turned loose on one of them can flood that
compartment without sinking the ship.

```
frontend/src/
  apps/        one folder per pipeline app — self-contained
  agents/      one folder per generation worker — self-contained
  panel/screens/   one file per model screen — self-contained
  shared/      the hull. High fan-in. Changes here reach everything.
  lib/         framework-level plumbing
backend/src/
  lib/         the hull, server side
```

### Duplicate behaviour, share contracts

The single rule that follows from this:

> **Duplicate behaviour. Share contracts.**

A *contract* is a shape both sides must agree on or the system breaks — a type,
an event name, a storage key, an endpoint path, a units convention. Those belong
in `shared/`, defined once. If two compartments disagree about a contract, they
are already broken.

*Behaviour* is how one compartment does its job. That gets copied, and the
copies are allowed to drift.

The clearest example: eight agents each define their own `pollStatus` loop, and
they are not identical. Their job timeouts are tuned to the workload —

| agent | timeout |
| --- | --- |
| `fal_image_gen`, `fal_generic`, `run_pipeline` | 10 min |
| `fal_video_gen`, `fal_ffmpeg_merge` | 15 min |
| `fal_rig`, `fal_image_to_3d` | 20 min |
| `fal_image_to_panorama` | 30 min |

De-duplicating them into one shared poller would look tidier and would be a
regression. It would create a module that every
generation path depends on, where a change tuned for one workload silently
retunes six others. That is exactly the coupling the structure exists to
prevent.

So when you notice two compartments doing something similar:

- **Same shape, different behaviour → leave it.** Two copies that drift on
  purpose are healthy.
- **Same shape, must never disagree → extract the contract**, not the code. A
  type or a constant in `shared/`, with the behaviour still local.
- **Genuinely one thing, used everywhere → it belongs in the hull.** Say so in
  the PR, because the hull is the part that can sink us.

Adding to `shared/` is a real architectural decision, not a refactor. Expect it
to be discussed.

### The rule the linter enforces

`.dependency-cruiser.cjs` fails the build on **sideways imports**:

- no `apps/a` importing from `apps/b`
- no `agents/a` importing from `agents/b`
- no `screens/a` importing from `screens/b`

Compartments talk to `shared/` and `lib/`, never to each other. If you need
something from a sibling, either it is a contract (move it to `shared/`) or it
is behaviour (copy it).

## The Miro Web SDK call budget

Miro rate-limits Web SDK calls, and this app can hit that ceiling in normal use.
Treat the call count as a design constraint, not an optimisation to do later.

In practice:

- `selection:update` and `items:delete` carry **full item payloads**. Read the
  event. Do not call `getSelection()` to learn something the event just told
  you.
- Fetch on mount, then stay event-driven. `panel/hooks/boardSelection.ts` is the
  pattern to copy.
- Steady-state interaction should cost **zero** SDK calls. If a feature makes
  calls per click, say so in the PR and explain why it has to.

An earlier version of the reference UI spent 2–5 calls per board click and ~12
per anchor change. That is what the basket model in `panel/hooks/basket.ts`
replaced.

## Conventions

- TypeScript strict; `npm run lint` is `tsc --noEmit` and must be clean.
- Comments explain **why**, not what. The existing ones set the register — match
  it rather than adding narration.
- Commit subjects are imperative and describe the change in behaviour
  ("Refuse to Generate before the click, not after it").
- No secrets in the repo. `FAL_KEY` lives in `backend/.env` and never reaches
  the browser; the frontend only ever holds the proxy key.

## Licensing your contribution

The project is Apache-2.0. By opening a pull request you agree your
contribution is licensed the same way — there is no CLA to sign.

If you fork rather than contribute, that's equally welcome. Apache-2.0 section
4(d) asks only that the attribution in [NOTICE](NOTICE) travels with what you
ship, in a NOTICE file, your docs, or a credits screen. The app itself carries
that line at the foot of its Settings panel.

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
