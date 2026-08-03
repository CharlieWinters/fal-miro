// Miro has no native video/audio/3D/panorama widgets, but its embed widget
// renders any iframable URL. These small HTML players are what those embeds
// point at — the same trick underlies all four.

function escapeHtml(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function videoPlayerHtml(url: string): string {
  const safe = escapeHtml(url);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    video { width: 100%; height: 100%; object-fit: contain; display: block; }
  </style>
</head>
<body>
  <video src="${safe}" controls autoplay muted loop playsinline></video>
</body>
</html>`;
}

export function audioPlayerHtml(url: string): string {
  const safe = escapeHtml(url);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      background: #141417;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 18px;
      box-sizing: border-box;
      font-family: system-ui, sans-serif;
    }
    .badge {
      flex: 0 0 auto;
      width: 44px;
      height: 44px;
      border-radius: 11px;
      background: rgba(255, 221, 51, 0.14);
      border: 1px solid rgba(255, 221, 51, 0.4);
      color: #FFDD33;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    audio { flex: 1 1 auto; width: 100%; height: 40px; }
  </style>
</head>
<body>
  <div class="badge">&#9835;</div>
  <audio src="${safe}" controls preload="metadata"></audio>
</body>
</html>`;
}

/** Shared by /embed/3d (auto-rotate + AR) and /embed/rig (autoplay animation). */
export function modelViewerHtml(
  url: string,
  opts: { autoRotate?: boolean; autoplay?: boolean; ar?: boolean } = {},
): string {
  const safe = escapeHtml(url);
  const attrs = [
    'camera-controls',
    opts.autoRotate ? 'auto-rotate' : '',
    opts.autoplay ? 'autoplay' : '',
    'touch-action="pan-y"',
    'shadow-intensity="1"',
    'exposure="1"',
    'environment-image="neutral"',
    opts.ar ? 'ar' : '',
  ]
    .filter(Boolean)
    .join('\n    ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script type="module" src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; background: #14142b; }
    model-viewer { width: 100%; height: 100%; --poster-color: #14142b; }
  </style>
</head>
<body>
  <model-viewer
    src="${safe}"
    ${attrs}
  ></model-viewer>
</body>
</html>`;
}

/** `proxiedUrl` should already point at our own /proxy (same-origin texture load). */
export function panoramaHtml(proxiedUrl: string): string {
  const safe = escapeHtml(proxiedUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://aframe.io/releases/1.5.0/aframe.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #14142b; }
    a-scene { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <a-scene embedded vr-mode-ui="enabled: false" loading-screen="enabled: false" cursor="rayOrigin: mouse">
    <a-assets>
      <!-- Same-origin (served via our /proxy) — no crossorigin needed, and
           adding it would force a CORS request the browser then blocks. -->
      <img id="pano" src="${safe}" />
    </a-assets>
    <!-- Equirectangular sky; drag to look around (default camera look-controls). -->
    <a-sky src="#pano"></a-sky>
  </a-scene>
</body>
</html>`;
}
