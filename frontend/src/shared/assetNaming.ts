// Asset naming — pull a short asset id (e.g. "CHR01") out of a prompt so a
// generated image can be named after the asset it depicts rather than the
// generic "Fal · Generated".
//
// The board convention is `ASSET_ID, prompt text…` — the id is the first
// comma-delimited token. The pattern is configurable (persisted per board via
// storage.getAssetNamingConfig) so a team can adapt it to their own scheme.

export type AssetNamingConfig = {
  /** Master switch — off means generated images keep the generic name. */
  enabled: boolean;
  /** RegExp source. Capture group 1 (or the whole match) is the asset id. */
  pattern: string;
  /** RegExp flags (e.g. "i"). "g" is stripped — we only take the first match. */
  flags: string;
};

// Default: a single alphanumeric token before the first comma — matches
// "CHR01, a knight in a field" → "CHR01", but leaves comma-free prompts (and
// prose like "a wide shot, then…") alone so we never mis-name a normal prompt.
export const DEFAULT_ASSET_NAMING: AssetNamingConfig = {
  enabled: true,
  pattern: '^\\s*([A-Za-z0-9][\\w-]*)\\s*,',
  flags: '',
};

/** Compile a config's pattern, or return the compile error message. */
export function compileAssetPattern(
  cfg: Pick<AssetNamingConfig, 'pattern' | 'flags'>,
): { re: RegExp } | { error: string } {
  try {
    // Drop the global flag — we only ever want the first match, and a lingering
    // `g` makes `.exec` stateful across calls.
    const flags = (cfg.flags ?? '').replace(/g/g, '');
    return { re: new RegExp(cfg.pattern, flags) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Invalid regular expression.' };
  }
}

/**
 * Extract the asset id from `text` using `cfg`, or null when naming is off, the
 * pattern is invalid, or nothing matches. Prefers capture group 1, falling back
 * to the whole match.
 */
export function extractAssetName(text: string, cfg: AssetNamingConfig): string | null {
  if (!cfg.enabled) return null;
  const t = (text ?? '').trim();
  if (!t) return null;
  const compiled = compileAssetPattern(cfg);
  if ('error' in compiled) return null;
  const m = compiled.re.exec(t);
  if (!m) return null;
  const captured = (m[1] ?? m[0]).trim();
  return captured || null;
}

/**
 * Remove the asset-id prefix from a prompt so only the description is sent to
 * the model. Only strips when the match sits at the very start (the documented
 * `ASSET_ID, prompt…` shape) — a mid-string match is left alone to avoid
 * mangling a real prompt. Any leftover leading comma/space is cleaned up.
 */
export function stripAssetName(text: string, cfg: AssetNamingConfig): string {
  const t = text ?? '';
  if (!cfg.enabled || !t.trim()) return t;
  const compiled = compileAssetPattern(cfg);
  if ('error' in compiled) return t;
  const m = compiled.re.exec(t);
  if (!m || m.index !== 0 || !m[0]) return t;
  return t.slice(m[0].length).replace(/^[\s,]+/, '');
}
