// node.html — the embed side of an embed node. No Miro SDK here, and nothing
// imported from outside src/embed (the embed-pages-stay-sdk-free rule), so the
// protocol constants are repeated in nodeProtocol.ts; node.test.ts checks
// they match shared/node.ts.
//
// This page cannot read the board. It walks the page's frame tree, posts
// hello {nid} to every frame at our own origin, and renders whatever the
// app's headless iframe answers. Nobody answering is a real state — the
// viewer doesn't have the app — and gets the install message, the same shape
// as miro-terminal's wrapper.
//
// Everything rendered is built with textContent: prompts and titles are board
// content that any editor can write.

import { INSTALL_URL, PAGE_MSG } from './nodeProtocol';

/** Retry for ~8 s: the headless iframe can still be booting when this loads. */
const RETRY_MS = 500;
const MAX_ATTEMPTS = 16;
/** Slow backstop for changes the push didn't reach (another browser's run). */
const REFRESH_MS = 20_000;
const OPEN_TIMEOUT_MS = 8_000;

type Output = { url: string; kind: 'image' | 'video'; posterUrl?: string; at?: string; by?: string | null };
type State = {
  nid: string;
  found: boolean;
  title?: string;
  modelLabel?: string;
  settings?: Array<{ label: string; value: string }>;
  prompt?: { text: string; source: 'sticky' | 'saved' } | null;
  references?: { images: string[]; videos: string[]; audios: string[] };
  lastOutput?: Output | null;
  canGenerate?: boolean;
  costUSD?: number;
  job?: { status: 'running' | 'succeeded' | 'failed'; message?: string; startedAt: number } | null;
};

const origin = window.location.origin;
const nid = new URLSearchParams(window.location.search).get('nid') ?? '';
const root = document.getElementById('root') as HTMLElement;

/** Every frame on the page except this one. */
function allFrames(): Window[] {
  const out: Window[] = [];
  const collect = (win: Window, depth: number) => {
    if (depth > 8 || out.length > 200) return;
    if (win !== window) out.push(win);
    let n = 0;
    try {
      n = win.length;
    } catch {
      return;
    }
    for (let i = 0; i < n; i++) {
      try {
        collect(win[i] as Window, depth + 1);
      } catch {
        /* cannot index into it */
      }
    }
  };
  let top: Window;
  try {
    void window.top?.length;
    top = window.top ?? window.parent;
  } catch {
    top = window.parent;
  }
  collect(top, 0);
  return out;
}

/** Once the app has answered, talk to that frame only. */
let appFrame: Window | null = null;

function post(message: Record<string, unknown>): void {
  const targets = appFrame ? [appFrame] : allFrames();
  for (const w of targets) {
    try {
      // Exact origin, never '*': the browser drops it for every frame that
      // isn't ours, including other apps' iframes.
      w.postMessage(message, origin);
    } catch {
      /* detached */
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function centre(...children: Array<Node | string>): void {
  root.className = 'centre';
  root.replaceChildren(...children.map((c) => (typeof c === 'string' ? el('div', undefined, c) : c)));
}

function renderNoApp(): void {
  const link = el('a', undefined, 'Install Fal for Miro');
  link.href = INSTALL_URL;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  const p = el('div');
  p.append('This is a Fal for Miro node: one shot’s settings, ready to generate. ', link, ' to use it.');
  centre(el('strong', undefined, 'The app isn’t running here'), p);
}

let openNote: HTMLElement | null = null;
let openButton: HTMLButtonElement | null = null;

function renderState(s: State): void {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = null;
  genButton = null;
  if (!s.found) {
    centre(
      el('strong', undefined, 'This node isn’t set up'),
      'The app couldn’t find settings for it on this board. It may have been copied from another board, or made by hand.',
    );
    return;
  }
  root.className = 'view';
  const main = el('main');

  main.append(el('h1', undefined, s.title || 'Fal node'), el('div', 'model', s.modelLabel ?? ''));

  if (s.settings?.length) {
    const chips = el('div', 'chips');
    for (const { label, value } of s.settings) chips.append(el('span', 'chip', `${label} ${value}`));
    main.append(chips);
  }

  const refs = s.references;
  const refBox = el('div', 'box');
  const refCount = refs ? refs.images.length + refs.videos.length + refs.audios.length : 0;
  refBox.append(el('div', 'label', refCount ? `References wired · ${refCount}` : 'References'));
  if (refCount && refs) {
    const ul = el('ul');
    for (const t of refs.images) ul.append(el('li', undefined, `Image · ${t}`));
    for (const t of refs.videos) ul.append(el('li', undefined, `Video · ${t}`));
    for (const t of refs.audios) ul.append(el('li', undefined, `Audio · ${t}`));
    refBox.append(ul);
  } else {
    refBox.append(el('div', 'prompt', 'Nothing wired yet. Draw a line from an image to this node.'));
  }
  main.append(refBox);

  const promptBox = el('div', 'box');
  promptBox.append(
    el('div', 'label', s.prompt?.source === 'sticky' ? 'Prompt · from the wired sticky' : 'Prompt'),
    el('div', 'prompt', s.prompt?.text || 'No prompt yet. Wire a sticky to this node.'),
  );
  main.append(promptBox);

  const out = s.lastOutput;
  const still = out ? (out.kind === 'image' ? out.url : out.posterUrl) : undefined;
  if (out) {
    const box = el('div', 'box result');
    box.append(el('div', 'label', out.kind === 'video' ? 'Last result · video' : 'Last result'));
    if (still) {
      const img = el('img');
      img.src = still;
      img.alt = '';
      box.append(img);
    }
    const when = out.at ? new Date(out.at).toLocaleString() : '';
    box.append(el('div', 'meta', [when, out.by ? `by ${out.by}` : ''].filter(Boolean).join(' · ')));
    main.append(box);
  }

  const job = s.job;
  if (job && job.status !== 'succeeded') {
    const box = el('div', job.status === 'failed' ? 'box job failed' : 'box job');
    box.append(el('div', 'label', job.status === 'failed' ? 'Last run failed' : 'Generating'));
    const line = el('div', 'prompt', job.message ?? '');
    if (job.status === 'running') {
      const tick = () => {
        const secs = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
        line.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${job.message ?? ''}`;
      };
      tick();
      jobTimer = setInterval(tick, 1000);
    }
    box.append(line);
    main.prepend(box);
  }

  const footer = el('footer');
  const running = job?.status === 'running';
  if (s.canGenerate) {
    const cost = typeof s.costUSD === 'number' ? ` · about $${s.costUSD.toFixed(2)}` : '';
    genButton = el('button', undefined, running ? 'Generating…' : `Generate${cost}`);
    genButton.type = 'button';
    genButton.disabled = running;
    genButton.addEventListener('click', () => request(PAGE_MSG.generate));
    footer.append(genButton);
  }
  openButton = el('button', s.canGenerate ? 'secondary' : undefined, 'Open in Fal');
  openButton.type = 'button';
  openButton.addEventListener('click', () => request(PAGE_MSG.open));
  openNote = el(
    'div',
    'note',
    s.canGenerate ? 'Generate asks you to confirm, with the cost, before anything runs.' : 'Opens the Fal panel on this node. Generate from there.',
  );
  footer.append(openButton, openNote);

  root.replaceChildren(main, footer);
}

let jobTimer: ReturnType<typeof setInterval> | null = null;
let genButton: HTMLButtonElement | null = null;

let openTimer: ReturnType<typeof setTimeout> | null = null;
function request(type: typeof PAGE_MSG.open | typeof PAGE_MSG.generate): void {
  if (!openNote) return;
  if (openButton) openButton.disabled = true;
  if (genButton) genButton.disabled = true;
  openNote.className = 'note';
  openNote.textContent = type === PAGE_MSG.generate ? 'Opening the confirm window…' : 'Opening the Fal panel…';
  post({ type, v: 1, nid });
  openTimer = setTimeout(() => finishOpen('No answer from the app. Try again, or open the panel from the toolbar.', true), OPEN_TIMEOUT_MS);
}
function finishOpen(message: string, isError: boolean): void {
  if (openTimer) clearTimeout(openTimer);
  openTimer = null;
  if (openButton) openButton.disabled = false;
  if (genButton && genButton.textContent !== 'Generating…') genButton.disabled = false;
  if (!openNote) return;
  openNote.textContent = message;
  openNote.className = isError ? 'note err' : 'note';
}

let answered = false;
function onMessage(event: MessageEvent): void {
  if (event.origin !== origin) return;
  const d = event.data as { type?: string; nid?: string } | null;
  if (!d || typeof d !== 'object' || d.nid !== nid) return;
  if (d.type === PAGE_MSG.state) {
    answered = true;
    if (event.source && 'postMessage' in event.source) appFrame = event.source as Window;
    renderState(d as unknown as State);
  } else if (d.type === PAGE_MSG.opened) {
    const what = (d as { what?: unknown }).what;
    finishOpen(what === 'confirm' ? 'Confirm in the Fal window to start.' : 'Opened in the Fal panel.', false);
  } else if (d.type === PAGE_MSG.error) {
    finishOpen(String((d as { error?: unknown }).error ?? 'The app could not open this node.'), true);
  } else if (d.type === PAGE_MSG.changed) {
    post({ type: PAGE_MSG.hello, v: 1, nid });
  }
}

function start(): void {
  if (window.parent === window) {
    centre(
      el('strong', undefined, 'This page belongs on a Miro board'),
      'It is a Fal for Miro node. Open the board it was made on to use it.',
    );
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(nid)) {
    centre(el('strong', undefined, 'This node’s link is incomplete'), 'It carries no node id.');
    return;
  }
  window.addEventListener('message', onMessage);

  let attempts = 0;
  const hello = () => post({ type: PAGE_MSG.hello, v: 1, nid });
  hello();
  attempts++;
  const retry = setInterval(() => {
    if (answered) return clearInterval(retry);
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(retry);
      renderNoApp();
      return;
    }
    hello();
    attempts++;
  }, RETRY_MS);

  setInterval(() => {
    if (answered && document.visibilityState === 'visible') hello();
  }, REFRESH_MS);
}

start();
