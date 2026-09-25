import { createRoot } from 'react-dom/client';
import { ThreeDViewerToImageScreen } from '../panel/screens/ThreeDViewerToImageScreen';
import { VideoToImageScreen } from '../panel/screens/VideoToImageScreen';
import { PanoramaToImageScreen } from '../panel/screens/PanoramaToImageScreen';
import { RigPoseScreen } from '../panel/screens/RigPoseScreen';
import { BonePoseScreen } from '../panel/screens/BonePoseScreen';
import { SceneBuilderScreen } from '../panel/screens/SceneBuilderScreen';
import { MotionStripScreen } from '../panel/screens/MotionStripScreen';
import { loadBackendConfig } from '../shared/backendConfig';
import '../styles/index.css';

/**
 * Modal iframe — hosts the fullscreen "→ Image" capture utilities (3D viewer,
 * video player) so the user gets a large, high-resolution view to capture from.
 *
 * The panel opens it via miro.board.ui.openModal with the tool + the target
 * item's id in the URL: `modal.html?tool=video-to-image&itemId=<id>`.
 */
function ModalApp() {
  const params = new URLSearchParams(window.location.search);
  const tool = params.get('tool');
  const itemId = params.get('itemId') ?? '';
  const close = () => void miro.board.ui.closeModal();

  if (itemId && tool === 'viewer3d-to-image') {
    return <ThreeDViewerToImageScreen itemId={itemId} onClose={close} />;
  }
  if (itemId && tool === 'video-to-image') {
    return <VideoToImageScreen itemId={itemId} onClose={close} />;
  }
  if (itemId && tool === 'panorama-to-image') {
    return <PanoramaToImageScreen itemId={itemId} onClose={close} />;
  }
  if (itemId && tool === 'rig-to-image') {
    return <RigPoseScreen itemId={itemId} onClose={close} />;
  }
  if (itemId && tool === 'pose-character') {
    return <BonePoseScreen itemId={itemId} onClose={close} />;
  }
  if (itemId && tool === 'motion-to-strip') {
    return <MotionStripScreen itemId={itemId} onClose={close} />;
  }
  if (tool === 'scene-builder') {
    return <SceneBuilderScreen onClose={close} />;
  }

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Fal for Miro</div>
        <div className="sub">Nothing to capture — open this from a selected model or video.</div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  // The panel is where a backend gets configured in the first place, so by
  // the time a capture tool opens this modal it's already set in this
  // browser's localStorage — just load it into this iframe's own copy of
  // api.ts before rendering.
  loadBackendConfig();
  createRoot(root).render(<ModalApp />);
} else {
  console.error('Modal: #root not found');
}
