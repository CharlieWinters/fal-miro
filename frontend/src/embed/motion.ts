// Motion embed — plays a Hunyuan Motion FBX (skinned mannequin + one clip) on
// a loop over a ground grid. A fourth, Miro-SDK-free surface like the other
// embed pages; it must never import anything from panel/, modal/ or agents/.
//
// The FBX references its texture by an absolute path inside fal's container,
// so the texture never loads; a flat material gives the wooden-mannequin look
// fal's own preview has. Bones are drawn as a skeleton overlay so the motion
// reads even when the mesh is small on the board.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fitMotionCamera, groundOffset, makeRootFollower } from './motionScene';

const status = document.getElementById('status') as HTMLDivElement;
const url = new URLSearchParams(window.location.search).get('url');

if (!url || !/^https?:\/\//.test(url)) {
  status.textContent = 'Missing or invalid url';
} else {
  void start(url);
}

async function start(src: string): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14142b);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a44, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(150, 300, 200);
  scene.add(key);
  scene.add(new THREE.GridHelper(600, 24, 0x5a5a86, 0x2c2c4a));

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  let mixer: THREE.AnimationMixer | null = null;
  let follow: () => void = () => undefined;
  try {
    const group = await new FBXLoader().loadAsync(src, (e) => {
      if (e.total) status.textContent = `Loading motion… ${Math.round((e.loaded / e.total) * 100)}%`;
    });
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0xc8a165, roughness: 0.7 });
      }
    });
    // Feet on the grid: shift by the rest-pose bounds, then let the clip's
    // root translation carry the figure across the floor.
    scene.add(group);
    scene.add(new THREE.SkeletonHelper(group));

    // Pose the first frame, then put the feet on the grid and frame the
    // figure from where the skeleton actually is.
    const clip = group.animations[0];
    if (clip) {
      mixer = new THREE.AnimationMixer(group);
      mixer.clipAction(clip).play();
      mixer.setTime(0);
    }
    group.position.y -= groundOffset(group);
    fitMotionCamera(camera, controls, group);
    follow = makeRootFollower(group, camera, controls);
    status.textContent = '';
  } catch (err) {
    status.textContent = `Could not load the motion (${err instanceof Error ? err.message : String(err)})`;
    return;
  }

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    mixer?.update(clock.getDelta());
    follow();
    controls.update();
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
