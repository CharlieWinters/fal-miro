// Asset naming runs a user-supplied regular expression over every prompt, so
// the interesting cases are the hostile ones: a pattern that doesn't compile, a
// pattern with a `g` flag (which makes `.exec` stateful and would return a
// different answer on every other call), and prose that happens to contain a
// comma.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ASSET_NAMING,
  compileAssetPattern,
  extractAssetName,
  stripAssetName,
  type AssetNamingConfig,
} from './assetNaming';

const cfg = (over: Partial<AssetNamingConfig> = {}): AssetNamingConfig => ({
  ...DEFAULT_ASSET_NAMING,
  ...over,
});

describe('compileAssetPattern', () => {
  it('compiles a valid pattern', () => {
    const r = compileAssetPattern({ pattern: '^\\w+', flags: 'i' });
    expect('re' in r).toBe(true);
  });

  it('returns the error instead of throwing on a bad pattern', () => {
    const r = compileAssetPattern({ pattern: '([unclosed', flags: '' });
    expect('error' in r).toBe(true);
  });

  it('strips the global flag, which would otherwise make exec stateful', () => {
    const r = compileAssetPattern({ pattern: 'a', flags: 'gi' });
    if (!('re' in r)) throw new Error('expected a compiled pattern');
    expect(r.re.flags).toBe('i');
    // Same input, same answer, twice — the property `g` would break.
    expect(r.re.exec('aa')?.index).toBe(0);
    expect(r.re.exec('aa')?.index).toBe(0);
  });
});

describe('extractAssetName', () => {
  it('pulls the id from the documented ASSET_ID, prompt shape', () => {
    expect(extractAssetName('CHR01, a knight in a field', cfg())).toBe('CHR01');
  });

  it('leaves comma-free prompts alone', () => {
    expect(extractAssetName('a knight in a field', cfg())).toBeNull();
  });

  it('does not mis-name prose that merely contains a comma', () => {
    // "a wide shot, then…" — the first token is not a bare id, so no match.
    expect(extractAssetName('a wide shot, then a close up', cfg())).toBeNull();
  });

  it('returns null when naming is switched off', () => {
    expect(extractAssetName('CHR01, a knight', cfg({ enabled: false }))).toBeNull();
  });

  it('returns null rather than throwing on an invalid pattern', () => {
    expect(extractAssetName('CHR01, a knight', cfg({ pattern: '([bad' }))).toBeNull();
  });

  it('handles empty and whitespace-only input', () => {
    expect(extractAssetName('', cfg())).toBeNull();
    expect(extractAssetName('   ', cfg())).toBeNull();
  });

  it('is stable across repeated calls even with a g flag configured', () => {
    const c = cfg({ flags: 'g' });
    expect(extractAssetName('CHR01, a knight', c)).toBe('CHR01');
    expect(extractAssetName('CHR01, a knight', c)).toBe('CHR01');
  });
});

describe('stripAssetName', () => {
  it('removes the id prefix and the separator', () => {
    expect(stripAssetName('CHR01, a knight in a field', cfg())).toBe('a knight in a field');
  });

  it('leaves the prompt untouched when there is no id', () => {
    expect(stripAssetName('a knight in a field', cfg())).toBe('a knight in a field');
  });

  it('only strips at position 0, so a mid-string match is left alone', () => {
    const c = cfg({ pattern: '([A-Z]{3}\\d{2})\\s*,' });
    const text = 'a knight, CHR01, in a field';
    expect(stripAssetName(text, c)).toBe(text);
  });

  it('passes the prompt through when naming is off or the pattern is bad', () => {
    expect(stripAssetName('CHR01, a knight', cfg({ enabled: false }))).toBe('CHR01, a knight');
    expect(stripAssetName('CHR01, a knight', cfg({ pattern: '([bad' }))).toBe('CHR01, a knight');
  });

  it('round-trips with extractAssetName', () => {
    const text = 'VEH07, a red bicycle leaning on a wall';
    expect(extractAssetName(text, cfg())).toBe('VEH07');
    expect(stripAssetName(text, cfg())).toBe('a red bicycle leaning on a wall');
  });
});
