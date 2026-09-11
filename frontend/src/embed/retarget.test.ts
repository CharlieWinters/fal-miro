import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBoneMap, canonicalBoneName, findAnimatedSkinnedMesh, retargetClip } from './retarget';

/** A bone chain with the given local offsets; returns the bones parents-first. */
function chain(spec: Array<{ name: string; offset: [number, number, number] }>): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  let parent: THREE.Bone | null = null;
  for (const s of spec) {
    const b = new THREE.Bone();
    b.name = s.name;
    b.position.set(...s.offset);
    if (parent) parent.add(b);
    bones.push(b);
    parent = b;
  }
  return bones;
}

/** Bind a skinned mesh to `bones` in their current pose, under a root group. */
function rig(bones: THREE.Bone[], meshName: string): { root: THREE.Group; mesh: THREE.SkinnedMesh } {
  const root = new THREE.Group();
  root.add(bones[0]);
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = meshName;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
  return { root, mesh };
}

const worldDir = (from: THREE.Object3D, to: THREE.Object3D) =>
  to.getWorldPosition(new THREE.Vector3()).sub(from.getWorldPosition(new THREE.Vector3())).normalize();

describe('bone naming', () => {
  it('canonicalises Mixamo-style names', () => {
    expect(canonicalBoneName('mixamorig:LeftUpLeg')).toBe('leftupleg');
    expect(canonicalBoneName('Left_Fore_Arm')).toBe('leftforearm');
    expect(canonicalBoneName('neck')).toBe('neck');
  });

  it('maps a Meshy rig, ordering its top-down numbered spine by depth', () => {
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    const s2 = new THREE.Bone();
    s2.name = 'Spine02';
    const s1 = new THREE.Bone();
    s1.name = 'Spine01';
    const s0 = new THREE.Bone();
    s0.name = 'Spine';
    const arm = new THREE.Bone();
    arm.name = 'LeftArm';
    const toe = new THREE.Bone();
    toe.name = 'head_end';
    hips.add(s2);
    s2.add(s1);
    s1.add(s0);
    s0.add(arm);
    const map = buildBoneMap([hips, s2, s1, s0, arm, toe]);
    expect(map.get(hips)).toBe('Pelvis');
    expect(map.get(s2)).toBe('Spine1');
    expect(map.get(s1)).toBe('Spine2');
    expect(map.get(s0)).toBe('Spine3');
    expect(map.get(arm)).toBe('L_Shoulder');
    expect(map.has(toe)).toBe(false);
  });
});

describe('retargetClip', () => {
  // Source: an SMPL-X-named arm that rests pointing straight out (+X) and, in
  // its clip, swings 90° up to +Y over one second.
  // Target: a Mixamo-named arm that rests pointing down (-Y), like an A-pose.
  // After retargeting, the target arm must point wherever the source arm points.
  function build() {
    const src = chain([
      { name: 'Pelvis', offset: [0, 100, 0] },
      { name: 'Spine1', offset: [0, 20, 0] },
      { name: 'L_Collar', offset: [5, 30, 0] },
      { name: 'L_Shoulder', offset: [10, 0, 0] },
      { name: 'L_Elbow', offset: [30, 0, 0] },
      { name: 'L_Wrist', offset: [25, 0, 0] },
    ]);
    const s = rig(src, 'mannequin');
    const tgt = chain([
      { name: 'Hips', offset: [0, 1.0, 0] },
      { name: 'Spine02', offset: [0, 0.2, 0] },
      { name: 'LeftShoulder', offset: [0.05, 0.3, 0] },
      { name: 'LeftArm', offset: [0.1, 0, 0] },
      { name: 'LeftForeArm', offset: [0, -0.3, 0] },
      { name: 'LeftHand', offset: [0, -0.25, 0] },
    ]);
    const t = rig(tgt, 'character');

    // The clip: L_Shoulder rotates about +Z from 0 to 90°, so the forearm goes from +X to +Y.
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const track = new THREE.QuaternionKeyframeTrack('L_Shoulder.quaternion', [0, 1], [...q0.toArray(), ...q1.toArray()]);
    const clip = new THREE.AnimationClip('swing', 1, [track]);
    return { s, t, clip, src, tgt };
  }

  it('makes the character arm follow the mannequin arm through the swing', () => {
    const { s, t, clip, src, tgt } = build();
    const { clip: out, mappedBones } = retargetClip(t.mesh, s.mesh, s.root, clip, 10);
    expect(mappedBones).toBeGreaterThanOrEqual(5);
    const srcMixer = new THREE.AnimationMixer(s.root);
    srcMixer.clipAction(clip).play();
    const tgtMixer = new THREE.AnimationMixer(t.mesh);
    tgtMixer.clipAction(out).play();
    const shoulder = src[3];
    const elbow = src[4];
    const arm = tgt[3];
    const forearm = tgt[4];
    for (const time of [0, 0.5, 0.9]) {
      srcMixer.setTime(time);
      s.root.updateMatrixWorld(true);
      tgtMixer.setTime(time);
      t.root.updateMatrixWorld(true);
      const want = worldDir(shoulder, elbow);
      const got = worldDir(arm, forearm);
      expect(got.dot(want), `t=${time}`).toBeGreaterThan(0.995);
    }
  });

  it('carries the hip travel across, scaled to the character', () => {
    const { s, t, clip } = build();
    // Add root travel: the pelvis moves 50 units along +Z over the clip (source is ~100 tall, target ~1.0 → ×0.01-ish).
    const pos = new THREE.VectorKeyframeTrack('Pelvis.position', [0, 1], [0, 100, 0, 0, 100, 50]);
    const moving = new THREE.AnimationClip('walk', 1, [...clip.tracks, pos]);
    const { clip: out, scale } = retargetClip(t.mesh, s.mesh, s.root, moving, 10);
    const hipTrack = out.tracks.find((tr) => tr.name === '.bones[Hips].position') as THREE.VectorKeyframeTrack;
    expect(hipTrack).toBeTruthy();
    const first = hipTrack.values.slice(0, 3);
    const last = hipTrack.values.slice(-3);
    // Ten samples over one second land on 0.0 … 0.9 s, so the last one sees 90% of the travel.
    const lastTime = hipTrack.times[hipTrack.times.length - 1];
    expect(last[2] - first[2]).toBeCloseTo(50 * lastTime * scale, 3);
    expect(scale).toBeGreaterThan(0.005);
    expect(scale).toBeLessThan(0.02);
  });

  it('finds the skinned mesh whose skeleton owns the graph’s named bone', () => {
    const a = chain([{ name: 'Pelvis', offset: [0, 0, 0] }]);
    const b = chain([{ name: 'Pelvis', offset: [0, 0, 0] }]);
    const root = new THREE.Group();
    const ra = rig(a, 'partA');
    const rb = rig(b, 'partB');
    root.add(rb.root, ra.root); // b first in traversal, so getObjectByName('Pelvis') is b's
    expect(findAnimatedSkinnedMesh(root)?.name).toBe('partB');
  });
});
