/**
 * Bulkhead enforcement — see CONTRIBUTING.md, "Duplicate behaviour, share
 * contracts".
 *
 * Each app, agent and screen is a sealed compartment. They may depend on the
 * hull (`shared/`, `lib/`, `styles/`) and on their own contents. They may not
 * depend on each other, because a sideways import is how one flooded
 * compartment takes the next one with it.
 *
 * If a rule below fires, you have one of two things:
 *   - a contract, which belongs in `shared/` — move the *type*, not the code
 *   - behaviour, which belongs to both compartments — copy it, and let the
 *     copies drift
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-app',
      severity: 'error',
      comment:
        'Pipeline apps must not import from each other. Each app is self-contained ' +
        'so it can be changed, broken or deleted without touching its neighbours.',
      from: { path: '^src/apps/([^/]+)/' },
      to: { path: '^src/apps/([^/]+)/', pathNot: '^src/apps/$1/' },
    },
    {
      name: 'no-cross-agent',
      severity: 'error',
      comment:
        'Agents must not import from each other. Their polling, retry and output ' +
        'handling are tuned per workload and are meant to differ.',
      from: { path: '^src/agents/([^/]+)/' },
      to: { path: '^src/agents/([^/]+)/', pathNot: '^src/agents/$1/' },
    },
    {
      name: 'no-cross-screen',
      severity: 'error',
      comment:
        'Screens must not import from each other. Shared UI belongs in panel/ or ' +
        'shared/; shared behaviour usually should not be shared at all.',
      from: { path: '^src/panel/screens/([^/]+)$' },
      to: { path: '^src/panel/screens/([^/]+)$', pathNot: '^src/panel/screens/$1$' },
    },
    {
      name: 'hull-stays-independent',
      severity: 'error',
      comment:
        'shared/ is the hull: everything depends on it, so it must depend on ' +
        'nothing above it. A shared module reaching back into an app, agent or ' +
        'screen inverts that and couples every compartment to one of them.',
      from: {
        path: '^src/shared/',
        // One documented exception. pipelineApps.ts is a registry aggregator:
        // its whole job is to know every app, and both the panel and the
        // run_pipeline agent need it, so it has to sit in the hull. The types
        // it builds against are split into pipelineAppTypes.ts precisely so
        // that consumers can depend on the contract without dragging in every
        // app. Adding a second name to this list should feel expensive.
        pathNot: '^src/shared/pipelineApps\\.ts$',
      },
      to: { path: '^src/(apps|agents|panel|modal|headless)/' },
    },
    {
      name: 'embed-pages-stay-sdk-free',
      severity: 'error',
      comment:
        'src/embed/ backs the static embed pages, which run on the board for every ' +
        'viewer with no Miro SDK and no backend. They may use three.js and each ' +
        'other, nothing else in the app.',
      from: { path: '^src/embed/' },
      to: { path: '^src/', pathNot: '^src/embed/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make load order load-bearing.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable module — probably dead code left behind by a refactor.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)vite-env\\.d\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
