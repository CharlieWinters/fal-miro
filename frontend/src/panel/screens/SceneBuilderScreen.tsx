import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { proxyUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { getSceneInputs, type SceneInputs } from '../../shared/storage';
import { ToneIconChip } from '../CapabilityIcon';
import { renderHiRes } from '../threeCapture';

type Gizmo = 'translate' | 'rotate' | 'scale';
const RATIO_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
];

type Ctx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  transform: TransformControls;
  raycaster: THREE.Raycaster;
  assets: THREE.Object3D[];
  raf: number;
  pmrem?: THREE.PMREMGenerator;
};

/**
 * 3D Scene Builder (the golden-flow "combine" step, in 3D).
 *
 * Loads the selected models into a three.js scene — with a selected panorama as
 * both the 360° background and image-based lighting — and lets the user
 * move / rotate / scale each with a gizmo and orbit the camera. Capturing frames
 * the composed scene to the board as an image, ready for Image → Video.
 */
export function SceneBuilderScreen({ onClose }: { onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const [inputs, setInputs] = useState<SceneInputs | null>(null);
  const [gizmo, setGizmo] = useState<Gizmo>('translate');
  const [ratio, setRatio] = useState(16 / 9);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getSceneInputs()
      .then((i) => mounted && setInputs(i ?? { assets: [] }))
      .catch(() => mounted && setError('Could not read the scene inputs.'));
    return () => {
      mounted = false;
    };
  }, []);

  // Letterbox the render frame to the chosen aspect ratio.
  const recomputeFrame = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (!cw || !ch) return;
    let w = cw;
    let h = cw / ratio;
    if (h > ch) {
      h = ch;
      w = ch * ratio;
    }
    setFrame({ w: Math.round(w), h: Math.round(h) });
  }, [ratio]);

  useEffect(() => {
    recomputeFrame();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recomputeFrame);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [recomputeFrame]);

  // Build the three.js scene once inputs + mount are ready.
  useEffect(() => {
    const mount = mountRef.current;
    if (!inputs || !mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(mount.clientWidth || 640, mount.clientHeight || 360);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
    camera.position.set(0, 1.5, 6);

    // Baseline lighting (in case there's no panorama environment).
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(3, 10, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -10;
    key.shadow.camera.right = 10;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    scene.add(key);

    // Soft ground shadow-catcher so objects feel planted.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.25 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1, 0);
    orbit.enableDamping = true;

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode('translate');
    // Don't orbit while dragging a gizmo.
    transform.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
    });
    scene.add(transform);

    const raycaster = new THREE.Raycaster();
    const ctx: Ctx = { renderer, scene, camera, orbit, transform, raycaster, assets: [], raf: 0 };
    ctxRef.current = ctx;

    // Panorama → background + image-based lighting.
    if (inputs.panorama) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      ctx.pmrem = pmrem;
      new THREE.TextureLoader().setCrossOrigin('anonymous').load(proxyUrl(inputs.panorama), (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        scene.background = tex;
        scene.environment = pmrem.fromEquirectangular(tex).texture;
      });
    }

    // Load each glb, auto-fit (center + normalize to ~2 units), spread on X.
    const loader = new GLTFLoader();
    inputs.assets.forEach((asset, i) => {
      loader.load(
        proxyUrl(asset.url),
        (gltf) => {
          const obj = gltf.scene;
          fitAndCenter(obj);
          obj.position.x = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * 2.2;
          obj.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) o.castShadow = true;
          });
          scene.add(obj);
          ctx.assets.push(obj);
          setLoadedCount((n) => n + 1);
        },
        undefined,
        () => setError(`Couldn't load "${asset.name ?? 'a model'}" (proxy may be down).`),
      );
    });

    // Click to select an asset → attach the gizmo. We pick by bounding box
    // (ray vs. each asset's world AABB) rather than mesh triangles: the models
    // are often skinned/complex, which three.js raycasts unreliably, so box
    // picking is far more consistent and forgiving. Skip when the press is on
    // the gizmo itself (transform.axis is set on hover).
    const box = new THREE.Box3();
    const hitPoint = new THREE.Vector3();
    const onPointerDown = (e: PointerEvent) => {
      if (transform.dragging || transform.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      let best: THREE.Object3D | null = null;
      let bestDist = Infinity;
      for (const a of ctx.assets) {
        box.setFromObject(a);
        if (box.isEmpty()) continue;
        if (raycaster.ray.intersectBox(box, hitPoint)) {
          const d = raycaster.ray.origin.distanceTo(hitPoint);
          if (d < bestDist) {
            bestDist = d;
            best = a;
          }
        }
      }
      if (best) {
        transform.attach(best);
        setHasSelection(true);
      } else {
        transform.detach();
        setHasSelection(false);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    const animate = () => {
      ctx.raf = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(ctx.raf);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      transform.dispose();
      orbit.dispose();
      ctx.pmrem?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [inputs]);

  // Resize renderer/camera to the letterboxed frame.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !frame) return;
    ctx.renderer.setSize(frame.w, frame.h);
    ctx.camera.aspect = frame.w / frame.h;
    ctx.camera.updateProjectionMatrix();
  }, [frame]);

  const setMode = (m: Gizmo) => {
    setGizmo(m);
    ctxRef.current?.transform.setMode(m);
  };

  const deleteSelected = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const obj = ctx.transform.object;
    if (!obj) return;
    ctx.transform.detach();
    ctx.scene.remove(obj);
    ctx.assets = ctx.assets.filter((a) => a !== obj);
    setHasSelection(false);
  };

  const handleCapture = async () => {
    const ctx = ctxRef.current;
    if (!ctx || !inputs) return;
    setBusy(true);
    setError(null);
    setStatus('Rendering scene…');
    try {
      // Hide the gizmo so it isn't baked into the capture.
      const attached = ctx.transform.object;
      ctx.transform.detach();
      const dataUrl = renderHiRes(ctx.renderer, ctx.scene, ctx.camera, ratio);
      if (attached) ctx.transform.attach(attached);

      const anchor = inputs.anchorItemId ? await resolveAbsolutePosition(inputs.anchorItemId) : null;
      const width = 900;
      const height = width / ratio;
      let x = 0;
      let y = 0;
      if (anchor) {
        x = anchor.absoluteX;
        y = anchor.absoluteY + anchor.height / 2 + 60 + height / 2;
      } else {
        const vp = await miro.board.viewport.get();
        x = vp.x + vp.width / 2;
        y = vp.y + vp.height / 2;
      }
      await createImageAtAbsolute({ url: dataUrl, x, y, width, title: 'Fal · Scene' });
      setStatus('Scene captured ✓');
      setTimeout(onClose, 800);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Capture failed: ${msg}`);
      setStatus(null);
      setBusy(false);
    }
  };

  const nothingToLoad = useMemo(() => inputs && inputs.assets.length === 0, [inputs]);

  return (
    <div className="capture">
      <div className="capture-head">
        <button type="button" className="back-link" onClick={onClose} aria-label="Close">
          ← Close
        </button>
        <ToneIconChip capability="model3d" />
        <div>
          <div className="title">3D Scene Builder</div>
          <div className="sub">Arrange the models, frame the shot, and capture the scene.</div>
        </div>
      </div>

      {nothingToLoad ? (
        <div className="capture-stage">
          <div className="empty-state">
            No 3D models to place. Select one or more generated 3D models (and optionally a panorama)
            on the board, then open Scene Builder.
          </div>
        </div>
      ) : (
        <>
          <div className="capture-stage" ref={stageRef}>
            <div
              className="capture-frame"
              ref={mountRef}
              style={frame ? { width: frame.w, height: frame.h } : { width: '100%', height: '100%' }}
            />
          </div>

          <div className="capture-controls">
            <div className="capture-ratios">
              <span className="label">Tool</span>
              {(['translate', 'rotate', 'scale'] as Gizmo[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`ratio-chip ${gizmo === m ? 'active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'translate' ? 'Move' : m === 'rotate' ? 'Rotate' : 'Scale'}
                </button>
              ))}
              <button type="button" className="ratio-chip" disabled={!hasSelection} onClick={deleteSelected}>
                Delete
              </button>
            </div>

            <div className="capture-ratios">
              <span className="label">Aspect ratio</span>
              {RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`ratio-chip ${opt.value === ratio ? 'active' : ''}`}
                  onClick={() => setRatio(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="hint">
              Click a model to select it, drag the gizmo to {gizmo}. Drag empty space to orbit the
              camera, scroll to zoom. Loaded {loadedCount}/{inputs?.assets.length ?? 0} model(s).
            </div>

            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy || loadedCount === 0} onClick={handleCapture}>
                {busy ? 'Working…' : 'Capture scene'}
              </button>
              {status && <span className="muted">{status}</span>}
              {error && <span className="error">{error}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Center a model at the origin and scale it to roughly 2 units tall. */
function fitAndCenter(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2 / maxDim;
  obj.scale.setScalar(scale);
  // Recenter on X/Z, and sit the model on the ground (y = 0).
  obj.position.x -= center.x * scale;
  obj.position.z -= center.z * scale;
  obj.position.y -= (center.y - size.y / 2) * scale;
}

