/** Truncate a long string (e.g. base64 data URI) so logs stay readable. */
export function summarize(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 80) return value;
  return `${value.slice(0, 60)}…(${value.length} chars)`;
}

/** Shallow-summarize an input object so data URIs don't flood the console. */
export function summarizeInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = summarize(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? summarize(x) : x));
    else out[k] = v;
  }
  return out;
}

export function logBox(debug: boolean, label: string, body: unknown): void {
  if (!debug) return;
  const dashes = '─'.repeat(60);
  console.log(`\n┌${dashes}`);
  console.log(`│ ${label}`);
  console.log(`├${dashes}`);
  console.log(JSON.stringify(body, null, 2).replace(/^/gm, '│ '));
  console.log(`└${dashes}\n`);
}
