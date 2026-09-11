// Geometry helpers shared by the motion embed page and the panel's Motion →
// Pose strip capture tool. Pure three.js, no DOM, so they are unit-testable.
import * as THREE from 'three';

/**
 * Bounds of the figure as posed right now. A skinned mesh's geometry bounds
 * describe its bind pose, not the pose the skeleton is in, and for the Hunyuan
 * FBX the two are far apart — so measure the bones (world positions after
 * updateMatrixWorld) and fall back to the mesh only when there is no skeleton.
 */
export function figureBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  let bones = 0;
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      box.expandByPoint(o.getWorldPosition(p));
      bones += 1;
    }
  });
  if (bones === 0) box.setFromObject(root);
  return box;
}

/** How far the figure's lowest point sits below y=0 in its current pose. */
export function groundOffset(root: THREE.Object3D): number {
  const box = figureBounds(root);
  return Number.isFinite(box.min.y) ? box.min.y : 0;
}

/**
 * Frame a standing figure: camera slightly above chest height, far enough back
 * for the whole body plus a stride's worth of travel. Works in the FBX's own
 * units (Hunyuan Motion exports in centimetres, ~178 tall).
 */
export function fitMotionCamera(
  camera: THREE.PerspectiveCamera,
  controls: { target: THREE.Vector3; update: () => void },
  root: THREE.Object3D,
): void {
  const box = figureBounds(root);
  const size = box.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 1);
  const centre = box.getCenter(new THREE.Vector3());
  controls.target.set(centre.x, box.min.y + height * 0.5, centre.z);
  camera.position.set(centre.x + height * 1.1, box.min.y + height * 0.8, centre.z + height * 2.6);
  camera.near = height / 100;
  camera.far = height * 60;
  camera.updateProjectionMatrix();
  controls.update();
}

/** Evenly spaced sample times across a clip, inclusive of the first frame and
 *  just short of the last so the loop's wrap frame is not duplicated. */
export function sampleTimes(duration: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1 || duration <= 0) return [0];
  const step = duration / n;
  return Array.from({ length: n }, (_, i) => Number((i * step).toFixed(3)));
}

/** The skeleton's root bone (the one whose parent is not a bone), if any. */
export function rootBone(root: THREE.Object3D): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Bone).isBone && !((o.parent as THREE.Bone | null)?.isBone)) found = o as THREE.Bone;
  });
  return found;
}

/**
 * Keep the camera on a figure that travels: each frame, shift camera and orbit
 * target by the root bone's horizontal movement since the last frame, so the
 * user's chosen angle and distance are preserved while the figure walks.
 * Vertical motion (a jump) is left alone so the ground stays put on screen.
 */
export function makeRootFollower(
  root: THREE.Object3D,
  camera: THREE.Camera,
  controls: { target: THREE.Vector3 },
): () => void {
  const bone = rootBone(root);
  const last = new THREE.Vector3();
  const now = new THREE.Vector3();
  let primed = false;
  return () => {
    if (!bone) return;
    bone.getWorldPosition(now);
    if (primed) {
      const dx = now.x - last.x;
      const dz = now.z - last.z;
      camera.position.x += dx;
      camera.position.z += dz;
      controls.target.x += dx;
      controls.target.z += dz;
    }
    last.copy(now);
    primed = true;
  };
}
