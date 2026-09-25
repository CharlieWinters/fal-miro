// Embed nodes — the parts that decide what a message may do and what the
// node shows. The channel is reachable by any page on this origin (a shared
// github.io host), so the parsers are the security boundary: pin what they
// refuse as firmly as what they accept.

import { describe, it, expect } from 'vitest';
import {
  NODE_MSG,
  buildNodeState,
  isNid,
  nodeTitleFromCard,
  parseNodeMeta,
  parseNodeRequest,
  type NodeMeta,
} from './node';
import { PAGE_MSG } from '../embed/nodeProtocol';

const NID = '0f8e4b1c-2d3a-4b5c-8d7e-9f0a1b2c3d4e';

function meta(extra: Partial<NodeMeta> = {}): NodeMeta {
  return {
    v: 1,
    nid: NID,
    title: 'Shot 2',
    recipe: {
      v: 1,
      endpointId: 'minimax/h3/reference-to-video',
      capability: 'video',
      input: { prompt: 'Wide establishing shot.', aspect_ratio: '9:16', resolution: '2K', duration: 6 },
      referenceField: null,
      videoReferenceField: null,
    },
    lastOutput: null,
    ...extra,
  };
}

const none = { images: [], videos: [], audios: [], stickies: [] };

describe('protocol', () => {
  it('node.html and the app use the same message names', () => {
    for (const [k, v] of Object.entries(PAGE_MSG)) {
      expect(NODE_MSG[k as keyof typeof NODE_MSG]).toBe(v);
    }
  });
});

describe('parseNodeRequest', () => {
  it('accepts hello and open with a uuid nid', () => {
    expect(parseNodeRequest({ type: 'fal-node:hello', v: 1, nid: NID })).toEqual({ type: 'fal-node:hello', v: 1, nid: NID });
    expect(parseNodeRequest({ type: 'fal-node:open', nid: NID })?.type).toBe('fal-node:open');
  });

  it('refuses every other message type, including the ones only the app sends', () => {
    for (const type of ['fal-node:state', 'fal-node:focus', 'fal-node:changed', 'run-agent', 'fal-node:generate']) {
      expect(parseNodeRequest({ type, nid: NID })).toBeNull();
    }
  });

  it('refuses a nid that is not a uuid', () => {
    for (const nid of ['', 'abc', `${NID}&x=1`, '../app.html', 42]) {
      expect(parseNodeRequest({ type: 'fal-node:hello', nid })).toBeNull();
    }
  });

  it('keeps nothing but the nid — extra fields in the message are dropped', () => {
    const req = parseNodeRequest({ type: 'fal-node:open', nid: NID, endpointId: 'x', input: { prompt: 'y' } });
    expect(req).toEqual({ type: 'fal-node:open', v: 1, nid: NID });
  });

  it('refuses non-objects', () => {
    for (const d of [null, undefined, 'fal-node:hello', 7]) expect(parseNodeRequest(d)).toBeNull();
  });
});

describe('isNid', () => {
  it('matches crypto.randomUUID output', () => {
    expect(isNid(crypto.randomUUID())).toBe(true);
  });
});

describe('parseNodeMeta', () => {
  it('round-trips a node', () => {
    expect(parseNodeMeta(JSON.parse(JSON.stringify(meta())))).toEqual(meta());
  });

  it('is not a node without a recipe, a version or a valid nid', () => {
    expect(parseNodeMeta({ ...meta(), recipe: undefined })).toBeNull();
    expect(parseNodeMeta({ ...meta(), v: 2 })).toBeNull();
    expect(parseNodeMeta({ ...meta(), nid: 'nope' })).toBeNull();
    expect(parseNodeMeta(null)).toBeNull();
  });

  it('drops a last output that is not an http(s) URL', () => {
    const m = parseNodeMeta({ ...meta(), lastOutput: { url: 'javascript:alert(1)', kind: 'image', at: '' } });
    expect(m?.lastOutput).toBeNull();
    const p = parseNodeMeta({
      ...meta(),
      lastOutput: { url: 'https://v3b.fal.media/a.mp4', kind: 'video', posterUrl: 'data:image/png;base64,AA', at: '' },
    });
    expect(p?.lastOutput?.posterUrl).toBeUndefined();
  });
});

describe('nodeTitleFromCard', () => {
  it('keeps the shot name and drops the model', () => {
    expect(nodeTitleFromCard('Shot 2 · MiniMax H3 Reference to Video')).toBe('Shot 2');
  });
  it('falls back when the card is the generic "Settings · model"', () => {
    expect(nodeTitleFromCard('Settings · Veo 3.1')).toBe('Fal node');
    expect(nodeTitleFromCard(undefined)).toBe('Fal node');
  });
});

describe('buildNodeState', () => {
  it('shows the saved prompt and the settings worth showing', () => {
    const s = buildNodeState(meta(), none, 'MiniMax H3 Reference to Video');
    expect(s.modelLabel).toBe('MiniMax H3 Reference to Video');
    expect(s.settings).toEqual([
      { label: 'Aspect', value: '9:16' },
      { label: 'Resolution', value: '2K' },
      { label: 'Duration', value: '6 s' },
    ]);
    expect(s.prompt).toEqual({ text: 'Wide establishing shot.', source: 'saved' });
  });

  it('a wired sticky wins over the saved prompt, as in the model screens', () => {
    const s = buildNodeState(meta(), { ...none, stickies: [{ id: 's', content: '<p>Rider waves</p>' }] }, undefined);
    expect(s.prompt).toEqual({ text: 'Rider waves', source: 'sticky' });
  });

  it('decodes entities in sticky text, since the node renders it as plain text', () => {
    const s = buildNodeState(meta(), { ...none, stickies: [{ id: 's', content: '<p>Rock &amp; roll &lt;3</p>' }] }, undefined);
    expect(s.prompt?.text).toBe('Rock & roll <3');
  });

  it('lists wired references by title', () => {
    const s = buildNodeState(
      meta(),
      { ...none, images: [{ id: '1', title: 'SH2_frame' }, { id: '2' }], videos: [{ id: '3', title: 'S2_MOVE' }] },
      undefined,
    );
    expect(s.references).toEqual({ images: ['SH2_frame', 'untitled'], videos: ['S2_MOVE'], audios: [] });
  });

  it('falls back to the endpoint id when the catalog has no label', () => {
    expect(buildNodeState(meta(), none, undefined).modelLabel).toBe('minimax/h3/reference-to-video');
  });

  it('trims a long prompt', () => {
    const long = 'x'.repeat(1000);
    const s = buildNodeState(meta({ recipe: { ...meta().recipe, input: { prompt: long } } }), none, undefined);
    expect(s.prompt?.text.length).toBeLessThanOrEqual(280);
    expect(s.prompt?.text.endsWith('…')).toBe(true);
  });
});
