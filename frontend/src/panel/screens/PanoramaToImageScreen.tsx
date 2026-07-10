import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { proxyUrl, unwrapPanoramaEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { ToneIconChip } from '../CapabilityIcon';
import { renderHiRes } from '../threeCapture';

type Embed = { id: string; url?: string; width?: number; height?: number };

/** Capture aspect-ratio choices (value = width / height). */
const RATIO_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
];

type Scene = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  raf: number;
  lon: number;
  lat: number;
  fov: number;
  autoRotate: boolean;
};

/**
 * Panorama Viewer → Image (a "manual operation" from the golden flow).
 *
 * Hosted fullscreen in the modal. Given a Fal panorama embed, it maps the
 * equirectangular image onto the inside of a sphere (three.js), lets the user
 * look around and pick a framing (aspect ratio), and captures the current
 * perspective view as a flat background image on the board — "cut the panorama
 * where you want the background to look" from the talktrack.
 */
export function PanoramaToImageScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void miro.board
      .getById(itemId)
      .then((it) => mounted && setEmbed(it as unknown as Embed))
      .catch(() => mounted && setError('Could not read the selected panorama.'));
    return () => {
      mounted = false;
    };
  }, [itemId]);

  const equirectUrl = useMemo(() => (embed?.url ? unwrapPanoramaEmbedUrl(embed.url) : null), [embed]);
  const src = useMemo(() => (equirectUrl ? proxyUrl(equirectUrl) : null), [equirectUrl]);

  // Fit a box of `ratio` inside the stage, letterboxed.
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

  // Set up the three.js photosphere once we have the image + a mount point.
  useEffect(() => {
    const mount = mountRef.current;
    if (!src || !mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth || 640, mount.clientHeight || 360);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.cursor = 'grab';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1100);

    const geo = new THREE.SphereGeometry(500, 60, 40);
    geo.scale(-1, 1, 1);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const tex = loader.load(
      src,
      () => setReady(true),
      undefined,
      () => setError('Could not load the panorama (proxy may be down).'),
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));

    const s: Scene = { renderer, camera, scene, raf: 0, lon: 0, lat: 0, fov: 75, autoRotate: true };
    sceneRef.current = s;

    // Manual look controls.
    let dragging = false;
    let px = 0;
    let py = 0;
    let plon = 0;
    let plat = 0;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      s.autoRotate = false;
      px = e.clientX;
      py = e.clientY;
      plon = s.lon;
      plat = s.lat;
      el.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      s.lon = plon - (e.clientX - px) * 0.15;
      s.lat = plat + (e.clientY - py) * 0.15;
    };
    const onUp = () => {
      dragging = false;
      el.style.cursor = 'grab';
    };
    const onWheel = (e: WheelEvent) => {
      s.fov = Math.max(25, Math.min(100, s.fov + e.deltaY * 0.05));
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: true });

    const animate = () => {
      s.raf = requestAnimationFrame(animate);
      if (s.autoRotate) s.lon += 0.03;
      s.lat = Math.max(-85, Math.min(85, s.lat));
      const phi = THREE.MathUtils.degToRad(90 - s.lat);
      const theta = THREE.MathUtils.degToRad(s.lon);
      camera.lookAt(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta),
      );
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(s.raf);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      renderer.dispose();
      tex.dispose();
      geo.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
      sceneRef.current = null;
    };
  }, [src]);

  // Resize the renderer/camera to the letterboxed frame.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !frame) return;
    s.renderer.setSize(frame.w, frame.h);
    s.camera.aspect = frame.w / frame.h;
    s.camera.updateProjectionMatrix();
  }, [frame]);

  const handleCapture = async () => {
    const s = sceneRef.current;
    if (!s || !embed) return;
    setBusy(true);
    setError(null);
    setStatus('Capturing view…');
    try {
      const dataUrl = renderHiRes(s.renderer, s.scene, s.camera, ratio);

      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      const width = abs.width || embed.width || 720;
      const height = width / ratio;
      const gap = 60;
      const x = abs.absoluteX;
      const y = abs.absoluteY + (abs.height || width / 2) / 2 + gap + height / 2;

      await createImageAtAbsolute({ url: dataUrl, x, y, width, title: 'Fal · panorama view' });
      setStatus('View captured ✓');
      setTimeout(onClose, 700);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = /tainted|insecure|security/i.test(msg)
        ? ' (the CORS proxy may not be running — check the backend)'
        : '';
      setError(`Capture failed: ${msg}${hint}`);
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
        <ToneIconChip capability="panorama" />
        <div>
          <div className="title">Panorama Viewer → Image</div>
          <div className="sub">Look around, frame the shot, and capture it as a background image.</div>
        </div>
      </div>

      {!src ? (
        <div className="capture-stage">
          <div className="empty-state">{error ?? 'Loading the selected panorama…'}</div>
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
              Drag to look around, scroll to zoom. The framed view is captured as a flat image on the
              board — ready for Image → Image or Image → Video.
            </div>
            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy || !ready} onClick={handleCapture}>
                {busy ? 'Working…' : ready ? 'Capture view' : 'Loading panorama…'}
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
