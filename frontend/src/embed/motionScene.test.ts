import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { figureBounds, fitMotionCamera, groundOffset, makeRootFollower, rootBone, sampleTimes } from './motionScene';

describe('sampleTimes', () => {
  it('spaces N samples evenly from the first frame, never landing on the wrap frame', () => {
    expect(sampleTimes(4, 4)).toEqual([0, 1, 2, 3]);
    expect(sampleTimes(3.97, 6).map((t) => Number(t.toFixed(2)))).toEqual([0, 0.66, 1.32, 1.99, 2.65, 3.31]);
  });

  it('handles a single pose and degenerate durations', () => {
    expect(sampleTimes(4, 1)).toEqual([0]);
    expect(sampleTimes(0, 6)).toEqual([0]);
    expect(sampleTimes(4, 0)).toEqual([0]);
  });
});

describe('groundOffset / fitMotionCamera', () => {
  const figure = () => {
    // A 178-unit tall box standing with its feet 19 below the origin, like the FBX's rest pose.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 178, 30));
    mesh.position.y = 178 / 2 - 19;
    const g = new THREE.Group();
    g.add(mesh);
    g.updateMatrixWorld(true);
    return g;
  };

  it('reports how far the feet sit below the ground plane', () => {
    expect(groundOffset(figure())).toBeCloseTo(-19, 3);
  });

  it('measures the skeleton, not the bind-pose mesh, when there are bones', () => {
    const g = new THREE.Group();
    // A mesh whose geometry sits somewhere unrelated, as an FBX bind pose does.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 178, 30));
    mesh.position.y = 500;
    g.add(mesh);
    const pelvis = new THREE.Bone();
    pelvis.position.set(0, 90, 0);
    const foot = new THREE.Bone();
    foot.position.set(10, -85, 0); // 5 above the ground once the pelvis is at 90
    pelvis.add(foot);
    const head = new THREE.Bone();
    head.position.set(0, 80, 0);
    pelvis.add(head);
    g.add(pelvis);
    const box = figureBounds(g);
    expect(box.min.y).toBeCloseTo(5, 3);
    expect(box.max.y).toBeCloseTo(170, 3);
    expect(groundOffset(g)).toBeCloseTo(5, 3);
  });

  it('frames the figure from a little above chest height, looking at its middle', () => {
    const g = figure();
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 5000);
    const controls = { target: new THREE.Vector3(), update: () => undefined };
    fitMotionCamera(camera, controls, g);
    expect(controls.target.y).toBeCloseTo(70, 0); // box centre: feet at -19, head at 159
    expect(camera.position.y).toBeGreaterThan(controls.target.y);
    expect(camera.position.z).toBeGreaterThan(178);
    expect(camera.far).toBeGreaterThan(camera.position.length());
  });
});

describe('root following', () => {
  it('finds the topmost bone', () => {
    const g = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.name = 'Pelvis';
    const hip = new THREE.Bone();
    pelvis.add(hip);
    g.add(pelvis);
    expect(rootBone(g)?.name).toBe('Pelvis');
    expect(rootBone(new THREE.Group())).toBeNull();
  });

  it('shifts camera and target by the root\'s horizontal travel, ignoring height', () => {
    const g = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.position.set(0, 90, 0);
    g.add(pelvis);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(100, 80, 300);
    const controls = { target: new THREE.Vector3(0, 90, 0) };
    const follow = makeRootFollower(g, camera, controls);
    follow(); // primes; no shift yet
    expect(camera.position.toArray()).toEqual([100, 80, 300]);
    pelvis.position.set(30, 120, -50); // walked and jumped
    g.updateMatrixWorld(true);
    follow();
    expect(camera.position.toArray()).toEqual([130, 80, 250]);
    expect(controls.target.toArray()).toEqual([30, 90, -50]);
  });
});
