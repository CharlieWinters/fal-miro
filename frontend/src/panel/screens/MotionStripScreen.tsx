import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { unwrapMotionCharacterUrl, unwrapMotionEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { setItemGenerationSettings, getItemGenerationSettings, type GenSettings } from '../../shared/storage';
import { fitMotionCamera, groundOffset, makeRootFollower, sampleTimes } from '../../embed/motionScene';
import { loadMotion } from '../../embed/motionLoad';
import { ToneIconChip } from '../CapabilityIcon';
import { renderHiRes } from '../threeCapture';

type Embed = { id: string; url?: string; width?: number; height?: number };

type Ctx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  follow: () => void;
  duration: number;
  raf: number;
};

const COUNT_OPTIONS = [4, 6, 8, 12];
const RATIO_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '3:4', value: 3 / 4 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
];

/**
 * Motion → Pose strip. The Miro-native form of an animation is not the clip,
 * it is a row of key poses: something to annotate, connect, and hand to the
 * first/last-frame video screens. This tool loads the motion FBX, lets the user
 * frame the figure, then samples the clip at N evenly spaced times and drops
 * each pose on the board as an image in a row below the embed.
 *
 * The FBX comes straight from fal's CDN (it sends CORS headers), so this works
 * in client mode too — no /proxy involved, unlike the other capture tools.
 */
export function MotionStripScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [fbxUrl, setFbxUrl] = useState<string | null>(null);
  const [characterUrl, setCharacterUrl] = useState<string | null>(null);
  const [count, setCount] = useState(6);
  const [ratio, setRatio] = useState(3 / 4);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>('Loading the motion…');
  const [error, setError] = useState<string | null>(null);

  // Resolve the embed → its FBX URL.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const it = (await miro.board.getById(itemId)) as unknown as Embed;
        if (!mounted) return;
        setEmbed(it);
        const url = it?.url ? unwrapMotionEmbedUrl(it.url) : null;
        if (!url) throw new Error('not a motion embed');
        setCharacterUrl(unwrapMotionCharacterUrl(it.url ?? ''));
        setFbxUrl(url);
      } catch {
        if (mounted) setError('Could not read the selected motion.');
      }
    })();
    return () => {
      mounted = false;
    };
  }, [itemId]);

  // Build the scene once the FBX URL is known.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !fbxUrl) return;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0c0e);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a44, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(150, 300, 200);
    scene.add(key);
    scene.add(new THREE.GridHelper(600, 24, 0x5a5a86, 0x2c2c4a));

    const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 1, 5000);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;

    loadMotion(fbxUrl, characterUrl, (loaded, total, what) => {
      if (total) setStatus(`Loading the ${what}… ${Math.round((loaded / total) * 100)}%`);
    }).then(
      (motion) => {
        if (disposed) return;
        scene.add(motion.root);
        if (!motion.onCharacter) scene.add(new THREE.SkeletonHelper(motion.figure));
        // Frame 0 is posed by loadMotion: feet on the grid, camera on the bones.
        motion.root.position.y -= groundOffset(motion.figure);
        fitMotionCamera(camera, orbit, motion.figure);
        const { mixer, action } = motion;
        const clock = new THREE.Clock();
        const ctx: Ctx = {
          renderer, scene, camera, orbit, mixer, action,
          follow: makeRootFollower(motion.figure, camera, orbit),
          duration: motion.duration, raf: 0,
        };
        const loop = () => {
          if (!ctx.action.paused) {
            ctx.mixer.update(clock.getDelta());
            setTime(ctx.mixer.time % ctx.duration);
          } else {
            clock.getDelta();
          }
          ctx.follow();
          ctx.orbit.update();
          ctx.renderer.render(ctx.scene, ctx.camera);
          ctx.raf = requestAnimationFrame(loop);
        };
        ctx.raf = requestAnimationFrame(loop);
        ctxRef.current = ctx;
        setDuration(motion.duration);
        setReady(true);
        setStatus(null);
      },
      (e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : 'Could not load the motion file.');
      },
    );

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(mount);

    return () => {
      disposed = true;
      ro?.disconnect();
      const ctx = ctxRef.current;
      if (ctx) cancelAnimationFrame(ctx.raf);
      ctxRef.current = null;
      orbit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [fbxUrl, characterUrl]);

  const seek = useCallback((t: number) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.action.paused = true;
    ctx.mixer.setTime(t);
    ctx.follow();
    setPlaying(false);
    setTime(t);
  }, []);

  const togglePlay = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.action.paused = playing;
    setPlaying(!playing);
  };

  const handleCapture = async () => {
    const ctx = ctxRef.current;
    if (!ctx || !embed) return;
    setBusy(true);
    setError(null);
    const wasPaused = ctx.action.paused;
    try {
      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      const settings = await getItemGenerationSettings<GenSettings>(embed.id);
      const times = sampleTimes(ctx.duration, count);
      // Each pose is a quarter of the embed's width, laid out left to right
      // below it, so a six-frame strip is 1.5 embeds wide.
      const width = Math.max(160, Math.round((abs.width || embed.width || 540) / 4));
      const height = width / ratio;
      const gap = 16;
      const stripWidth = times.length * width + (times.length - 1) * gap;
      const startX = abs.absoluteX - stripWidth / 2 + width / 2;
      const y = abs.absoluteY + (abs.height || width) / 2 + 60 + height / 2;

      ctx.action.paused = true;
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        setStatus(`Capturing pose ${i + 1} of ${times.length}…`);
        ctx.mixer.setTime(t);
        ctx.follow();
        const dataUrl = renderHiRes(ctx.renderer, ctx.scene, ctx.camera, ratio, 1024);
        const placed = await createImageAtAbsolute({
          url: dataUrl,
          x: startX + i * (width + gap),
          y,
          width,
          title: `Fal · pose @ ${t.toFixed(1)}s`,
        });
        await setItemGenerationSettings(placed.id, {
          endpointId: settings?.endpointId ?? 'fal-ai/hunyuan-motion',
          input: { ...(settings?.input ?? {}), pose_time_s: t },
          ratio: ratio >= 1 ? `${Math.round(ratio * 100)}:100` : `100:${Math.round(100 / ratio)}`,
          parents: [embed.id],
        });
      }
      setStatus(`Placed ${times.length} poses ✓`);
      setTimeout(onClose, 700);
    } catch (e) {
      setError(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
      setStatus(null);
      setBusy(false);
      ctx.action.paused = wasPaused;
    }
  };

  return (
    <div className="capture">
      <div className="capture-head">
        <button type="button" className="back-link" onClick={onClose} aria-label="Close">
          ← Close
        </button>
        <ToneIconChip capability="motion" />
        <div>
          <div className="title">Motion → Pose strip</div>
          <div className="sub">
            Frame the {characterUrl ? 'character' : 'figure'}, then sample the clip into a row of key poses.
          </div>
        </div>
      </div>

      <div className="capture-stage" ref={mountRef} style={{ padding: 0 }}>
        {!ready && <div className="empty-state" style={{ position: 'absolute' }}>{error ?? status}</div>}
      </div>

      <div className="capture-controls">
        <div className="capture-actions">
          <button type="button" className="reset-link" onClick={togglePlay} disabled={!ready}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ flex: 1 }}
            disabled={!ready || !duration}
          />
          <span className="muted">{time.toFixed(2)} / {duration.toFixed(2)} s</span>
        </div>

        <div className="capture-ratios">
          <span className="label">Poses</span>
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              className={`ratio-chip ${n === count ? 'active' : ''}`}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
          <span className="label" style={{ marginLeft: 12 }}>Each pose</span>
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
          Drag to orbit, scroll to zoom — the current camera is used for every pose. Poses are sampled evenly
          across the clip and placed in a row under the motion, ready for Image → Video or a first/last-frame
          screen.
        </div>

        <div className="capture-actions">
          <button className="primary" type="button" disabled={busy || !ready} onClick={handleCapture}>
            {busy ? 'Working…' : ready ? `Capture ${count} poses` : 'Loading…'}
          </button>
          {status && ready && <span className="muted">{status}</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
