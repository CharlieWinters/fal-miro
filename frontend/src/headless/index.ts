import { initializeMessageListener } from './communications';
import { agentRegistry } from './agentRegistry';
import { run as resumeActiveJobs } from '../agents/resume_jobs/headless/logic';
import { loadBackendConfig, watchBackendConfig } from '../shared/backendConfig';

async function init(): Promise<void> {
  // Wire the agents into the message listener. This is the composition root:
  // the only place that knows both the full agent list and the transport.
  initializeMessageListener(agentRegistry);

  // Open the panel when the user clicks the app icon in the Miro toolbar.
  await miro.board.ui.on('icon:click', async () => {
    await miro.board.ui.openPanel({ url: 'app.html' });
  });

  // Load this browser's backend config before anything that might call it —
  // the panel is where the user actually sets one up. This iframe runs
  // independently of the panel (dispatches /api/fal/run, polls resume_jobs),
  // so also watch for the user changing it later in Settings — otherwise
  // we'd keep using a stale backend until the whole board reloads.
  watchBackendConfig((configured) => {
    console.log(`[headless] backend config changed — now ${configured ? 'configured' : 'unconfigured'}`);
  });
  const configured = loadBackendConfig();
  if (!configured) {
    console.warn('[headless] no backend configured in this browser yet — open the panel to set one up.');
  } else {
    // On board load, resume any jobs we left in flight (survives the user
    // closing & re-opening the board).
    try {
      await resumeActiveJobs(undefined);
    } catch (err) {
      console.warn('[headless] resume on boot failed:', err);
    }
  }

  console.log('[headless] Fal for Miro ready');
}

init();
