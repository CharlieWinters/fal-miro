import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { proxyUrl, unwrapRigEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import {
  getItemGenerationSettings,
  getSavedPoses,
  saveSavedPose,
  deleteSavedPose,
  type GenSettings,
  type SavedPose,
} from '../../shared/storage';
import { ToneIconChip } from '../CapabilityIcon';
import { renderHiRes } from '../threeCapture';

type Clip = { name: string; url: string };

type Embed = { id: string; url?: string; width?: number; height?: number };

const RATIO_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
];

type Handle = THREE.Mesh & { userData: { bone: THREE.Bone } };

type Ctx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  transform: TransformControls;
  raycaster: THREE.Raycaster;
  handles: Handle[];
  /** Initial local rotations, to support Reset pose. */
  initialRot: Map<THREE.Bone, THREE.Quaternion>;
  raf: number;
};

/**
 * Manual (FK) character poser. Loads the rest-pose rig, drops a clickable
 * handle on each skeleton joint, and lets the user rotate a joint with a gizmo
 * — bending arms, turning the head, etc. — then captures the custom pose to the
 * board. Forward-kinematics only (rotate a joint; its children follow); no IK.
 */
export function BonePoseScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [glbUrl, setGlbUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState(3 / 4);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [nav, setNav] = useState<'orbit' | 'fly'>('orbit');
  const navRef = useRef<'orbit' | 'fly'>('orbit');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pose library: clips from this rig (route 1) + user-saved poses (route 2).
  const [clips, setClips] = useState<Clip[]>([]);
  const [savedPoses, setSavedPoses] = useState<SavedPose[]>([]);
  const clipPoseCache = useRef<Map<string, Record<string, number[]>>>(new Map());

  // Resolve the embed + the rest-pose rig url (metadata → embed glb fallback).
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const it = (await miro.board.getById(itemId)) as unknown as Embed;
        if (!mounted) return;
        setEmbed(it);
        const settings = await getItemGenerationSettings<GenSettings>(itemId);
        const url = settings?.restPoseUrl ?? (it?.url ? unwrapRigEmbedUrl(it.url) : null);
        if (!mounted) return;
        setGlbUrl(url);
        setClips(settings?.animations ?? []);
        setSavedPoses(await getSavedPoses(itemId));
      } catch {
        if (mounted) setError('Could not read the selected character.');
      }
    })();
    return () => {
      mounted = false;
    };
  }, [itemId]);

  const src = useMemo(() => (glbUrl ? proxyUrl(glbUrl) : null), [glbUrl]);

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

  // Build the three.js poser once the rig url + mount are ready.
  useEffect(() => {
    const mount = mountRef.current;
    if (!src || !mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth || 640, mount.clientHeight || 360);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 3 / 4, 0.1, 2000);
    camera.position.set(0, 1.4, 4);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 10, 5);
    scene.add(key);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1, 0);
    orbit.enableDamping = true;

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode('rotate');
    transform.setSpace('local');
    transform.setSize(0.6);
    transform.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
    });
    scene.add(transform);

    const raycaster = new THREE.Raycaster();
    const handles: Handle[] = [];
    const initialRot = new Map<THREE.Bone, THREE.Quaternion>();
    const ctx: Ctx = { renderer, scene, camera, orbit, transform, raycaster, handles, initialRot, raf: 0 };
    ctxRef.current = ctx;

    const loader = new GLTFLoader();
    loader.load(
      src,
      (gltf) => {
        const model = gltf.scene;
        // Center + normalize to ~2 units, sit on the ground.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const s = 2 / maxDim;
        model.scale.setScalar(s);
        model.position.x = -center.x * s;
        model.position.z = -center.z * s;
        model.position.y = -(center.y - size.y / 2) * s;
        scene.add(model);

        // Collect bones + drop a clickable handle on each joint.
        const bones: THREE.Bone[] = [];
        model.traverse((o) => {
          if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
        });
        // Fixed, comfortably-clickable size (the model is normalized to ~2 units).
        const handleR = 0.045;
        const handleGeo = new THREE.SphereGeometry(handleR, 16, 16);
        const handleMat = new THREE.MeshBasicMaterial({ color: 0x7c5cff, depthTest: false, transparent: true, opacity: 0.9 });
        for (const bone of bones) {
          initialRot.set(bone, bone.quaternion.clone());
          const h = new THREE.Mesh(handleGeo, handleMat.clone()) as unknown as Handle;
          h.userData.bone = bone;
          h.renderOrder = 999;
          scene.add(h);
          handles.push(h);
        }
        setReady(true);
        if (bones.length === 0) setError('This character has no adjustable skeleton.');
      },
      undefined,
      () => setError('Could not load the rig (proxy may be down).'),
    );

    // First-person state (used only in Fly mode).
    const keys = new Set<string>();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    let looking = false;
    let lastX = 0;
    let lastY = 0;
    const MOVE_CODES = new Set([
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    ]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (navRef.current === 'fly' && MOVE_CODES.has(e.code)) {
        keys.add(e.code);
        e.preventDefault(); // don't scroll the page / trigger focused buttons
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Click a joint handle → select its bone (orbit mode). In fly mode, a drag
    // looks around instead.
    const onPointerDown = (e: PointerEvent) => {
      if (navRef.current === 'fly') {
        looking = true;
        lastX = e.clientX;
        lastY = e.clientY;
        euler.setFromQuaternion(camera.quaternion);
        return;
      }
      if (transform.dragging || transform.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(handles, false);
      if (hits.length) {
        transform.attach((hits[0].object as Handle).userData.bone);
        setHasSelection(true);
      } else {
        transform.detach();
        setHasSelection(false);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (navRef.current !== 'fly' || !looking) return;
      euler.y -= (e.clientX - lastX) * 0.0025;
      euler.x -= (e.clientY - lastY) * 0.0025;
      euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
      lastX = e.clientX;
      lastY = e.clientY;
      camera.quaternion.setFromEuler(euler);
    };
    const onPointerUp = () => {
      looking = false;
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const tmp = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const right = new THREE.Vector3();
    const clock = new THREE.Clock();
    const animate = () => {
      ctx.raf = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      if (navRef.current === 'fly') {
        const speed = 2 * delta * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1);
        camera.getWorldDirection(dir);
        right.crossVectors(dir, camera.up).normalize();
        if (keys.has('KeyW') || keys.has('ArrowUp')) camera.position.addScaledVector(dir, speed);
        if (keys.has('KeyS') || keys.has('ArrowDown')) camera.position.addScaledVector(dir, -speed);
        if (keys.has('KeyD') || keys.has('ArrowRight')) camera.position.addScaledVector(right, speed);
        if (keys.has('KeyA') || keys.has('ArrowLeft')) camera.position.addScaledVector(right, -speed);
        if (keys.has('KeyE') || keys.has('Space')) camera.position.y += speed;
        if (keys.has('KeyQ')) camera.position.y -= speed;
      } else {
        orbit.update();
      }
      // Keep each handle glued to its (possibly-rotated) joint.
      for (const h of handles) {
        h.userData.bone.getWorldPosition(tmp);
        h.position.copy(tmp);
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(ctx.raf);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      transform.dispose();
      orbit.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !frame) return;
    ctx.renderer.setSize(frame.w, frame.h);
    ctx.camera.aspect = frame.w / frame.h;
    ctx.camera.updateProjectionMatrix();
  }, [frame]);

  const resetPose = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.transform.detach();
    setHasSelection(false);
    ctx.initialRot.forEach((q, bone) => bone.quaternion.copy(q));
  };

  // Apply a {boneName → quaternion} map to the rig; bones not listed reset to rest.
  const applyRotations = (rot: Record<string, number[]>) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.transform.detach();
    setHasSelection(false);
    ctx.initialRot.forEach((rest, bone) => {
      const q = rot[bone.name];
      if (q && q.length === 4) bone.quaternion.set(q[0], q[1], q[2], q[3]);
      else bone.quaternion.copy(rest);
    });
  };

  // Capture the current pose as a compact map — only bones rotated away from
  // rest (keeps saved poses small enough for appData).
  const capturePose = (): Record<string, number[]> => {
    const ctx = ctxRef.current;
    const rot: Record<string, number[]> = {};
    if (!ctx) return rot;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    ctx.initialRot.forEach((rest, bone) => {
      const q = bone.quaternion;
      if (Math.abs(q.angleTo(rest)) > 0.02) rot[bone.name] = [r(q.x), r(q.y), r(q.z), r(q.w)];
    });
    return rot;
  };

  // Route 1 — sample a clip's first frame as a pose (same skeleton → apply by name).
  const sampleClipPose = async (url: string): Promise<Record<string, number[]>> => {
    const cached = clipPoseCache.current.get(url);
    if (cached) return cached;
    const gltf = await new Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>((resolve, reject) =>
      new GLTFLoader().load(proxyUrl(url), resolve as never, undefined, () => reject(new Error('load failed'))),
    );
    const root = gltf.scene;
    const clip = gltf.animations?.[0];
    if (clip) {
      const mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(clip).play();
      mixer.setTime(0.0001);
      root.updateMatrixWorld(true);
    }
    const rot: Record<string, number[]> = {};
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        const q = o.quaternion;
        rot[o.name] = [q.x, q.y, q.z, q.w];
      }
    });
    clipPoseCache.current.set(url, rot);
    return rot;
  };

  const onApplyClip = async (clip: Clip) => {
    setStatus(`Applying ${clip.name}…`);
    setError(null);
    try {
      applyRotations(await sampleClipPose(clip.url));
      setStatus(null);
    } catch {
      setError(`Couldn't load the ${clip.name} pose.`);
      setStatus(null);
    }
  };

  const onSavePose = async () => {
    const rot = capturePose();
    if (Object.keys(rot).length === 0) {
      setStatus('Pose the character first, then save.');
      setTimeout(() => setStatus(null), 2500);
      return;
    }
    const name = `Pose ${savedPoses.length + 1}`;
    try {
      setSavedPoses(await saveSavedPose(itemId, { name, rot }));
    } catch {
      setError('Pose storage is full — delete a saved pose and try again.');
    }
  };

  const onDeleteSaved = async (name: string) => {
    setSavedPoses(await deleteSavedPose(itemId, name));
  };

  const setHandlesVisible = (v: boolean) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const h of ctx.handles) h.visible = v;
  };

  const switchNav = (mode: 'orbit' | 'fly') => {
    setNav(mode);
    navRef.current = mode;
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (mode === 'fly') {
      ctx.orbit.enabled = false;
      ctx.transform.detach();
      setHasSelection(false);
    } else {
      // Re-anchor the orbit target in front of the camera so the view doesn't
      // snap back when returning from fly.
      const dir = new THREE.Vector3();
      ctx.camera.getWorldDirection(dir);
      ctx.orbit.target.copy(ctx.camera.position).addScaledVector(dir, 3);
      ctx.orbit.enabled = true;
    }
  };

  const handleCapture = async () => {
    const ctx = ctxRef.current;
    if (!ctx || !embed) return;
    setBusy(true);
    setError(null);
    setStatus('Capturing pose…');
    try {
      const attached = ctx.transform.object;
      ctx.transform.detach();
      setHandlesVisible(false);
      const dataUrl = renderHiRes(ctx.renderer, ctx.scene, ctx.camera, ratio);
      setHandlesVisible(true);
      if (attached) ctx.transform.attach(attached);

      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      const width = abs.width || embed.width || 480;
      const height = width / ratio;
      const gap = 60;
      const x = abs.absoluteX;
      const y = abs.absoluteY + (abs.height || width) / 2 + gap + height / 2;
      await createImageAtAbsolute({ url: dataUrl, x, y, width, title: 'Fal · custom pose' });
      setStatus('Pose captured ✓');
      setTimeout(onClose, 700);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Capture failed: ${msg}`);
      setStatus(null);
      setBusy(false);
    }
  };

  return (
    <div className="capture">
      <div className="capture-head">
        <button type="button" className="back-link" onClick={onClose} aria-label="Close">
          ← Close
        </button>
        <ToneIconChip capability="rig" />
        <div>
          <div className="title">Pose Character (manual)</div>
          <div className="sub">Click a joint, rotate it to pose, then capture.</div>
        </div>
      </div>

      {!src ? (
        <div className="capture-stage">
          <div className="empty-state">{error ?? 'Loading the character…'}</div>
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
              <span className="label">Navigate</span>
              <button
                type="button"
                className={`ratio-chip ${nav === 'orbit' ? 'active' : ''}`}
                onClick={() => switchNav('orbit')}
              >
                Orbit
              </button>
              <button
                type="button"
                className={`ratio-chip ${nav === 'fly' ? 'active' : ''}`}
                onClick={() => switchNav('fly')}
              >
                Fly (first-person)
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

            <div className="capture-ratios">
              <span className="label">Poses</span>
              <button type="button" className="ratio-chip" onClick={resetPose} disabled={!ready} title="Reset to the rig's rest pose">
                Rest
              </button>
              {clips.map((c) => (
                <button
                  key={c.url}
                  type="button"
                  className="ratio-chip"
                  disabled={!ready}
                  onClick={() => void onApplyClip(c)}
                  title="Apply this animation's pose (you can tweak it after)"
                >
                  {c.name}
                </button>
              ))}
              {savedPoses.map((p) => (
                <span key={p.name} style={{ display: 'inline-flex', gap: 2 }}>
                  <button type="button" className="ratio-chip" disabled={!ready} onClick={() => applyRotations(p.rot)}>
                    {p.name}
                  </button>
                  <button
                    type="button"
                    className="ratio-chip"
                    title={`Delete ${p.name}`}
                    onClick={() => void onDeleteSaved(p.name)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button type="button" className="ratio-chip" disabled={!ready} onClick={() => void onSavePose()}>
                ＋ Save pose
              </button>
            </div>

            <div className="hint">
              {nav === 'orbit' ? (
                <>
                  Click a purple joint to select it, then drag the ring gizmo to rotate it — children
                  follow (forward kinematics). Drag empty space to orbit, scroll to zoom.
                  {hasSelection ? ' A joint is selected.' : ' No joint selected.'}
                </>
              ) : (
                <>
                  Fly mode: drag to look, <strong>W/A/S/D</strong> (or arrows) to move,{' '}
                  <strong>E/Space</strong> up, <strong>Q</strong> down, <strong>Shift</strong> to go
                  faster. Switch back to Orbit to select and pose joints.
                </>
              )}
            </div>

            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy || !ready} onClick={handleCapture}>
                {busy ? 'Working…' : ready ? 'Capture pose' : 'Loading…'}
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
