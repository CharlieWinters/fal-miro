// Pipeline app registry — aggregates each app's definition from its own
// folder under src/apps/<app-id>/index.ts, mirroring how
// shared/agentRegistry.ts aggregates src/agents/<id>/index.ts. Add a new app
// by adding a folder + one line below — never by editing another app's file
// (see the board brainstorm: apps are deliberately one-off, not a shared
// schema).

import type { PipelineAppDef } from './pipelineAppTypes';
import { appDef as sketchToTryOn } from '../apps/sketch-to-tryon';
import { appDef as nanoBananaPattern } from '../apps/nano-banana-pattern';

export type { PipelineAppDef, PipelineStepDef } from './pipelineAppTypes';

const APPS: PipelineAppDef[] = [sketchToTryOn, nanoBananaPattern];

export const PIPELINE_APPS: Record<string, PipelineAppDef> = APPS.reduce(
  (acc, app) => {
    acc[app.id] = app;
    return acc;
  },
  {} as Record<string, PipelineAppDef>,
);
