// Load a Hunyuan Motion clip for display: the mannequin as shipped, or the
// same motion retargeted onto a rigged character. Shared by the motion embed
// page and the panel's Motion → Pose strip tool; three.js only, no DOM.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { figureBounds } from './motionScene';
import { findAnimatedSkinnedMesh, firstSkinnedMesh, retargetClip } from './retarget';

export type LoadedMotion = {
  /** Add this to the scene. Sized in the FBX's units (centimetres). */
  root: THREE.Object3D;
  /** Whose bones to follow with the camera and to measure. */
  figure: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  duration: number;
  /** True when the clip is playing on a character rather than the mannequin. */
  onCharacter: boolean;
  /** Bones the character took from the motion (0 for the mannequin). */
  mappedBones: number;
};

export type ProgressFn = (loaded: number, total: number, what: 'motion' | 'character') => void;

const MANNEQUIN = new THREE.MeshStandardMaterial({ color: 0xc8a165, roughness: 0.7 });

/**
 * Load the FBX and, if `characterUrl` is given, a glTF character to retarget
 * onto. The mannequin's texture path points inside fal's container and never
 * resolves, so it gets a flat material; the character keeps its own.
 */
export async function loadMotion(fbxUrl: string, characterUrl?: string | null, onProgress?: ProgressFn): Promise<LoadedMotion> {
  const fbxP = new FBXLoader().loadAsync(fbxUrl, (e) => onProgress?.(e.loaded, e.total, 'motion'));
  const gltfP = characterUrl ? new GLTFLoader().loadAsync(characterUrl, (e) => onProgress?.(e.loaded, e.total, 'character')) : null;
  const fbx = await fbxP;
  const clip = fbx.animations[0];
  if (!clip) throw new Error('The motion file has no animation clip.');

  if (!gltfP) {
    fbx.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = MANNEQUIN;
    });
    const mixer = new THREE.AnimationMixer(fbx);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.setTime(0);
    return { root: fbx, figure: fbx, mixer, action, duration: clip.duration, onCharacter: false, mappedBones: 0 };
  }

  const gltf = await gltfP;
  const character = gltf.scene;
  const source = findAnimatedSkinnedMesh(fbx);
  const target = firstSkinnedMesh(character);
  if (!source) throw new Error('The motion file has no skinned skeleton to read.');
  if (!target) throw new Error('That character has no skeleton — rig it first (Meshy Rigging).');
  fbx.updateMatrixWorld(true);
  character.updateMatrixWorld(true);

  const { clip: retargeted, mappedBones } = retargetClip(target, source, fbx, clip, 30);
  if (mappedBones === 0) throw new Error('That character’s bones are not named in a way this tool recognises.');
  const mixer = new THREE.AnimationMixer(target);
  const action = mixer.clipAction(retargeted);
  action.play();
  mixer.setTime(0);

  // Show the character at the mannequin's size so the grid, camera and pose
  // strip framing behave the same either way.
  fbx.updateMatrixWorld(true);
  const fbxHeight = figureBounds(fbx).getSize(new THREE.Vector3()).y;
  character.updateMatrixWorld(true);
  const charHeight = figureBounds(character).getSize(new THREE.Vector3()).y;
  const wrap = new THREE.Group();
  wrap.name = 'character';
  wrap.scale.setScalar(charHeight > 0 ? fbxHeight / charHeight : 1);
  wrap.add(character);
  wrap.updateMatrixWorld(true);
  return { root: wrap, figure: wrap, mixer, action, duration: clip.duration, onCharacter: true, mappedBones };
}
