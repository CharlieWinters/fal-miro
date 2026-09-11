// Agent registry — maps agent id → runner. Each capability lives in its own
// `src/agents/<id>/` folder (index.ts = metadata + run, headless/logic.ts = the
// work).
//
// This is the composition root for the headless iframe, and the one module
// allowed to know every agent. It deliberately does NOT live in shared/: only
// headless/ needs it, and putting it in the hull would make every compartment
// transitively depend on all the others. The contract it builds against lives
// in shared/agentTypes.ts.

import type { AgentMeta, AgentRegistry } from '../shared/agentTypes';
import { agentMeta as falImageGen } from '../agents/fal_image_gen';
import { agentMeta as falVideoGen } from '../agents/fal_video_gen';
import { agentMeta as falImageTo3d } from '../agents/fal_image_to_3d';
import { agentMeta as falImageToPanorama } from '../agents/fal_image_to_panorama';
import { agentMeta as falRig } from '../agents/fal_rig';
import { agentMeta as falMotion } from '../agents/fal_motion';
import { agentMeta as falFfmpegMerge } from '../agents/fal_ffmpeg_merge';
import { agentMeta as falGeneric } from '../agents/fal_generic';
import { agentMeta as resumeJobs } from '../agents/resume_jobs';
import { agentMeta as runPipeline } from '../agents/run_pipeline';

export const agentList: AgentMeta[] = [
  falImageGen,
  falVideoGen,
  falImageTo3d,
  falImageToPanorama,
  falRig,
  falMotion,
  falFfmpegMerge,
  falGeneric,
  resumeJobs,
  runPipeline,
];

export const agentRegistry: AgentRegistry = agentList.reduce((acc, agent) => {
  acc[agent.id] = agent;
  return acc;
}, {} as AgentRegistry);
