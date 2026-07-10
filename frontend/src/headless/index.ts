import './communications';
import { run as resumeActiveJobs } from '../agents/resume_jobs/headless/logic';

async function init(): Promise<void> {
  // Open the panel when the user clicks the app icon in the Miro toolbar.
  await miro.board.ui.on('icon:click', async () => {
    await miro.board.ui.openPanel({ url: 'app.html' });
  });

  // On board load, resume any jobs we left in flight (survives the user
  // closing & re-opening the board).
  try {
    await resumeActiveJobs(undefined);
  } catch (err) {
    console.warn('[headless] resume on boot failed:', err);
  }

  console.log('[headless] Fal for Miro ready');
}

init();
