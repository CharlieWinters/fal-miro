// Agent registry — maps agent id → runner. Each capability lives in its own
// `src/agents/<id>/` folder (index.ts = metadata + run, headless/logic.ts = the
// work), exactly like the Runway/ElevenLabs apps.

import { agentMeta as falImageGen } from '../agents/fal_image_gen';
import { agentMeta as falVideoGen } from '../agents/fal_video_gen';
import { agentMeta as falImageTo3d } from '../agents/fal_image_to_3d';
import { agentMeta as falImageToPanorama } from '../agents/fal_image_to_panorama';
import { agentMeta as falRig } from '../agents/fal_rig';
import { agentMeta as falFfmpegMerge } from '../agents/fal_ffmpeg_merge';
import { agentMeta as falGeneric } from '../agents/fal_generic';
import { agentMeta as resumeJobs } from '../agents/resume_jobs';

export interface AgentMeta {
  id: string;
  name: string;
  run: (payload: unknown, requestId?: string) => Promise<unknown>;
}

export const agentList: AgentMeta[] = [
  falImageGen,
  falVideoGen,
  falImageTo3d,
  falImageToPanorama,
  falRig,
  falFfmpegMerge,
  falGeneric,
  resumeJobs,
];

export const agentRegistry = agentList.reduce(
  (acc, agent) => {
    acc[agent.id] = agent;
    return acc;
  },
  {} as Record<string, AgentMeta>,
);
