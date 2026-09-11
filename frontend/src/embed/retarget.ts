// Retarget a Hunyuan Motion clip (SMPL-X skeleton) onto a rigged character
// (Meshy / Mixamo-style skeleton). Pure three.js, no DOM.
//
// Why not SkeletonUtils.retargetClip: it copies world rotations across by name
// and assumes both rigs' bind poses share bone axes. SMPL-X bones and a
// Blender-exported Mixamo rig do not, so the result is a crumpled figure.
//
// What this does instead, per frame, for every mapped target bone:
//   1. delta   = sourceWorldRotation(now) * inverse(sourceWorldRotation(bind))
//      — how far the mannequin's bone has turned from its own rest, in world.
//   2. world   = delta * alignedRest — apply that to the character's rest, after
//      first turning each character bone so its rest *direction* (towards its
//      child) matches the mannequin's. That alignment is what makes a T-pose
//      mannequin drive an A-pose character without the arms ending up wrong.
//   3. local   = inverse(parentWorld) * world, baked into a keyframe track.
// The hip additionally takes the mannequin's root travel, scaled by the two
// figures' heights. Unmapped bones (fingers, toes, head-end) follow their
// parent at their rest rotation.
import * as THREE from 'three';

/** Canonical Mixamo-style name (lowercased, prefix and separators stripped) → SMPL-X bone. */
const CANON_TO_SMPLX: Record<string, string> = {
  hips: 'Pelvis',
  leftupleg: 'L_Hip',
  leftleg: 'L_Knee',
  leftfoot: 'L_Ankle',
  lefttoebase: 'L_Foot',
  rightupleg: 'R_Hip',
  rightleg: 'R_Knee',
  rightfoot: 'R_Ankle',
  righttoebase: 'R_Foot',
  neck: 'Neck',
  head: 'Head',
  leftshoulder: 'L_Collar',
  leftarm: 'L_Shoulder',
  leftforearm: 'L_Elbow',
  lefthand: 'L_Wrist',
  rightshoulder: 'R_Collar',
  rightarm: 'R_Shoulder',
  rightforearm: 'R_Elbow',
  righthand: 'R_Wrist',
};

/** Spine bones are matched by depth below the hips, because Meshy numbers
 *  them top-down (Spine02 → Spine01 → Spine) and Mixamo bottom-up. */
const SMPLX_SPINE = ['Spine1', 'Spine2', 'Spine3'];

/** Bones whose rest direction is not worth aligning: the clavicle is a short
 *  stub on one rig and reaches the sternum on the other, and aligning it only
 *  rolls the shoulder. They still take the source's rotation delta. */
const NO_ALIGN = new Set(['L_Collar', 'R_Collar']);

export function canonicalBoneName(name: string): string {
  return name.replace(/^mixamorig:?/i, '').replace(/[\s_:.]/g, '').toLowerCase();
}

/** target bone → SMPL-X source bone name, for every target bone we understand. */
export function buildBoneMap(targetBones: THREE.Bone[]): Map<THREE.Bone, string> {
  const map = new Map<THREE.Bone, string>();
  const spines: THREE.Bone[] = [];
  for (const b of targetBones) {
    const c = canonicalBoneName(b.name);
    if (CANON_TO_SMPLX[c]) map.set(b, CANON_TO_SMPLX[c]);
    else if (/^spine/.test(c)) spines.push(b);
  }
  spines.sort((a, b) => boneDepth(a) - boneDepth(b));
  SMPLX_SPINE.forEach((s, i) => {
    if (spines[i]) map.set(spines[i], s);
  });
  return map;
}

function boneDepth(b: THREE.Object3D): number {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d += 1;
  return d;
}

/** Hunyuan's FBX carries one bone hierarchy per body part; only one of them is
 *  the animated one. The skinned mesh whose skeleton owns the bone the scene
 *  graph resolves by name is the one to read. */
export function findAnimatedSkinnedMesh(root: THREE.Object3D, rootBoneName = 'Pelvis'): THREE.SkinnedMesh | null {
  const pelvis = root.getObjectByName(rootBoneName);
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!found && m.isSkinnedMesh && (!pelvis || m.skeleton.bones.includes(pelvis as THREE.Bone))) found = m;
  });
  return found;
}

export function firstSkinnedMesh(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  return found;
}

/** World matrix of each bone in the mesh's bind pose. */
function bindWorldMatrices(mesh: THREE.SkinnedMesh): THREE.Matrix4[] {
  return mesh.skeleton.bones.map((_, i) =>
    new THREE.Matrix4().copy(mesh.skeleton.boneInverses[i]).invert().premultiply(mesh.bindMatrix),
  );
}

const rotationOf = (m: THREE.Matrix4): THREE.Quaternion => {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
};
const positionOf = (m: THREE.Matrix4): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(m);

function heightOf(mats: THREE.Matrix4[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of mats) {
    const y = positionOf(m).y;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi - lo;
}

/** The mapped bone (child, else grandchild) whose position gives this bone its direction. */
function directionChild(b: THREE.Bone, map: Map<THREE.Bone, string>): THREE.Bone | null {
  const kids = b.children.filter((c): c is THREE.Bone => (c as THREE.Bone).isBone);
  const direct = kids.filter((c) => map.has(c));
  if (direct.length) return direct.find((c) => /^Spine/.test(map.get(c) ?? '')) ?? direct[0];
  for (const k of kids) {
    const g = k.children.filter((c): c is THREE.Bone => (c as THREE.Bone).isBone && map.has(c as THREE.Bone));
    if (g.length) return g[0];
  }
  return null;
}

export type RetargetResult = {
  clip: THREE.AnimationClip;
  /** How many target bones were driven by the source. */
  mappedBones: number;
  /** targetHeight / sourceHeight in their own units. */
  scale: number;
};

/**
 * Bake `clip` (which animates `sourceRoot`, whose skinned mesh is `source`)
 * into a clip that animates `target`'s skeleton. Play the result with an
 * AnimationMixer rooted at `target` (the SkinnedMesh), since the tracks are
 * addressed as `.bones[Name]`.
 */
export function retargetClip(
  target: THREE.SkinnedMesh,
  source: THREE.SkinnedMesh,
  sourceRoot: THREE.Object3D,
  clip: THREE.AnimationClip,
  fps = 30,
): RetargetResult {
  const map = buildBoneMap(target.skeleton.bones);
  const srcIndex = new Map(source.skeleton.bones.map((b, i) => [b.name, i] as const));
  const tBind = bindWorldMatrices(target);
  const sBind = bindWorldMatrices(source);
  const tBindQ = tBind.map(rotationOf);
  const sBindQ = sBind.map(rotationOf);
  const scale = heightOf(tBind) / Math.max(heightOf(sBind), 1e-6);

  const order = [...target.skeleton.bones].sort((a, b) => boneDepth(a) - boneDepth(b));
  const tIndex = new Map(target.skeleton.bones.map((b, i) => [b, i] as const));
  const parentRot = (b: THREE.Bone, boneRot: (p: THREE.Bone) => THREE.Quaternion): THREE.Quaternion =>
    b.parent && (b.parent as THREE.Bone).isBone ? boneRot(b.parent as THREE.Bone) : rotationOf(b.parent!.matrixWorld);

  // Rest rotation of each target bone relative to its parent, from the bind pose.
  const restLocal = new Map<THREE.Bone, THREE.Quaternion>();
  for (const b of order) {
    const pq = parentRot(b, (p) => tBindQ[tIndex.get(p)!]);
    restLocal.set(b, pq.clone().invert().multiply(tBindQ[tIndex.get(b)!]));
  }

  // The character's rest, re-posed bone by bone so each mapped bone points the
  // way the mannequin's does. Top-down, so children start from aligned parents.
  const alignedRest = new Map<THREE.Bone, THREE.Quaternion>();
  for (const b of order) {
    const start = parentRot(b, (p) => alignedRest.get(p)!).multiply(restLocal.get(b)!);
    let q = start;
    const srcName = map.get(b);
    if (srcName !== undefined && srcIndex.has(srcName) && !NO_ALIGN.has(srcName)) {
      const kid = directionChild(b, map);
      const kidSrc = kid ? map.get(kid) : undefined;
      if (kid && kidSrc !== undefined && srcIndex.has(kidSrc)) {
        const bp = positionOf(tBind[tIndex.get(b)!]);
        const kp = positionOf(tBind[tIndex.get(kid)!]);
        const offsetLocal = kp.sub(bp).applyQuaternion(tBindQ[tIndex.get(b)!].clone().invert());
        const dirNow = offsetLocal.applyQuaternion(start).normalize();
        const dirSrc = positionOf(sBind[srcIndex.get(kidSrc)!]).sub(positionOf(sBind[srcIndex.get(srcName)!])).normalize();
        if (dirNow.lengthSq() > 0 && dirSrc.lengthSq() > 0) {
          q = new THREE.Quaternion().setFromUnitVectors(dirNow, dirSrc).multiply(start);
        }
      }
    }
    alignedRest.set(b, q);
  }

  const mixer = new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(clip).play();
  const frames = Math.max(2, Math.round(clip.duration * fps));
  const times = new Float32Array(frames);
  const quatValues = new Map(order.map((b) => [b, new Float32Array(frames * 4)] as const));
  const hipBone = order.find((b) => map.get(b) === 'Pelvis');
  const hipValues = hipBone ? new Float32Array(frames * 3) : null;
  const tHipRest = hipBone ? positionOf(tBind[tIndex.get(hipBone)!]) : null;
  const sHipRest = srcIndex.has('Pelvis') ? positionOf(sBind[srcIndex.get('Pelvis')!]) : null;

  const worldNow = new Map<THREE.Bone, THREE.Quaternion>();
  const delta = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  let mappedBones = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    times[f] = t;
    mixer.setTime(t);
    sourceRoot.updateMatrixWorld(true);
    for (const b of order) {
      const srcName = map.get(b);
      const pw = parentRot(b, (p) => worldNow.get(p)!);
      let world: THREE.Quaternion;
      if (srcName !== undefined && srcIndex.has(srcName)) {
        const si = srcIndex.get(srcName)!;
        delta.copy(rotationOf(source.skeleton.bones[si].matrixWorld)).multiply(sBindQ[si].clone().invert());
        world = delta.clone().multiply(alignedRest.get(b)!);
        if (f === 0) mappedBones += 1;
      } else {
        world = pw.clone().multiply(restLocal.get(b)!);
      }
      worldNow.set(b, world);
      local.copy(pw).invert().multiply(world);
      local.toArray(quatValues.get(b)!, f * 4);
      if (b === hipBone && hipValues && tHipRest && sHipRest) {
        const sHipNow = positionOf(source.skeleton.bones[srcIndex.get('Pelvis')!].matrixWorld);
        const target = tHipRest.clone().add(sHipNow.sub(sHipRest).multiplyScalar(scale));
        b.parent!.worldToLocal(target).toArray(hipValues, f * 3);
      }
    }
  }
  mixer.stopAllAction();

  const tracks: THREE.KeyframeTrack[] = [];
  for (const b of order) {
    if (map.has(b)) tracks.push(new THREE.QuaternionKeyframeTrack(`.bones[${b.name}].quaternion`, times, quatValues.get(b)!));
  }
  if (hipBone && hipValues) tracks.push(new THREE.VectorKeyframeTrack(`.bones[${hipBone.name}].position`, times, hipValues));
  return { clip: new THREE.AnimationClip(`${clip.name || 'motion'} → ${target.name || 'character'}`, clip.duration, tracks), mappedBones, scale };
}
