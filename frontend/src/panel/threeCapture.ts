import * as THREE from 'three';

/**
 * Render a three.js scene to a high-resolution PNG data URL, independent of the
 * on-screen viewport size. Temporarily enlarges the render buffer to `longEdge`
 * on its long side (keeping the current aspect), captures, then restores — so
 * the visible canvas is unchanged but the exported image is crisp.
 *
 * The renderer must be created with `preserveDrawingBuffer: true`.
 */
export function renderHiRes(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  ratio: number,
  longEdge = 2048,
): string {
  const origSize = renderer.getSize(new THREE.Vector2());
  const origPixelRatio = renderer.getPixelRatio();

  // Target dimensions at the same aspect ratio as the on-screen frame.
  const tw = ratio >= 1 ? longEdge : Math.round(longEdge * ratio);
  const th = ratio >= 1 ? Math.round(longEdge / ratio) : longEdge;

  // updateStyle=false → grow only the drawing buffer, not the canvas CSS size.
  renderer.setPixelRatio(1);
  renderer.setSize(tw, th, false);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');

  // Restore the on-screen buffer.
  renderer.setPixelRatio(origPixelRatio);
  renderer.setSize(origSize.x, origSize.y, false);
  renderer.render(scene, camera);
  return url;
}
