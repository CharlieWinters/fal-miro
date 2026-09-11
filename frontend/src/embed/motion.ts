// Motion embed — plays a Hunyuan Motion FBX on a loop over a ground grid,
// either as the mannequin it ships with or retargeted onto a rigged character
// (`&character=<glb url>`). A fourth, Miro-SDK-free surface like the other
// embed pages; it must never import anything from panel/, modal/ or agents/.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fitMotionCamera, groundOffset, makeRootFollower } from './motionScene';
import { loadMotion } from './motionLoad';

const status = document.getElementById('status') as HTMLDivElement;
const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const character = params.get('character');
const isHttp = (u: string | null): u is string => Boolean(u && /^https?:\/\//.test(u));

if (!isHttp(url)) {
  status.textContent = 'Missing or invalid url';
} else {
  void start(url, isHttp(character) ? character : null);
}

async function start(src: string, characterUrl: string | null): Promise<void> {
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
    const motion = await loadMotion(src, characterUrl, (loaded, total, what) => {
      if (total) status.textContent = `Loading ${what}… ${Math.round((loaded / total) * 100)}%`;
    });
    scene.add(motion.root);
    // The skeleton overlay is what makes the motion legible on a small
    // mannequin; a textured character reads on its own.
    if (!motion.onCharacter) scene.add(new THREE.SkeletonHelper(motion.figure));
    // Frame 0 is posed by loadMotion: put the feet on the grid and frame the
    // figure from where its bones actually are.
    motion.root.position.y -= groundOffset(motion.figure);
    fitMotionCamera(camera, controls, motion.figure);
    follow = makeRootFollower(motion.figure, camera, controls);
    mixer = motion.mixer;
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
