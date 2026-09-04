// The prompt, as a basket of sticky notes plus a free textarea.
//
// Two fields, not one, and deliberately so: the notes and the typed text are
// concatenated at send time (notes first), never merged into a single editable
// string. That's what kills the original complaint — selecting a sticky used
// to overwrite what you'd typed, because the two shared one value. Here
// there's no derived string to fight over, so editing the text can't detach
// anything and adding a note can't destroy anything.
//
// The "Sent to the model" strip shows the assembled result with every
// @Image1-style token resolved: cyan when it points at a real basket item, red
// and wavy when it points past the end. The user's words are never rewritten.

import { useMemo } from 'react';
import { pluralOf, quantity, type Basket } from './hooks/basket';
import { BasketPanel } from './Basket';

export type TokenCounts = { Image: number; Video: number; Audio: number };

const TOKEN_RE = /(@(?:Image|Video|Audio)\d+)/g;

/** The full prompt actually sent: notes in basket order, then the typed text. */
export function assemblePrompt(basket: Basket, text: string): string {
  return [...basket.items.map((i) => i.label), text]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

type Part = { text: string; kind: 'plain' | 'token' | 'dangling' };

function splitPrompt(full: string, counts: TokenCounts): { parts: Part[]; dangling: string[] } {
  const parts: Part[] = [];
  const dangling: string[] = [];
  for (const seg of full.split(TOKEN_RE)) {
    if (!seg) continue;
    const m = /^@(Image|Video|Audio)(\d+)$/.exec(seg);
    if (!m) {
      parts.push({ text: seg, kind: 'plain' });
      continue;
    }
    const n = Number(m[2]);
    const max = counts[m[1] as keyof TokenCounts] ?? 0;
    const ok = n >= 1 && n <= max;
    if (!ok) dangling.push(seg);
    parts.push({ text: seg, kind: ok ? 'token' : 'dangling' });
  }
  return { parts, dangling };
}

export function PromptBasket({
  basket,
  text,
  onTextChange,
  counts,
}: {
  basket: Basket;
  text: string;
  onTextChange: (t: string) => void;
  /** How many items each media basket holds — for resolving tokens. */
  counts: TokenCounts;
}) {
  const full = useMemo(() => assemblePrompt(basket, text), [basket, text]);
  const { parts, dangling } = useMemo(() => splitPrompt(full, counts), [full, counts]);

  return (
    <div className="pb">
      <div className="bk-head">
        <span className="bk-title">Prompt</span>
        <span className="bk-count">{quantity(basket.items.length, 'note')}</span>
      </div>

      {/* The notes half reuses the basket rows — same grab/remove/reorder,
          no @token, since a note isn't addressable. */}
      <BasketPanel basket={basket} title="" showTokens={false} />

      <textarea
        className="pb-text"
        rows={3}
        value={text}
        placeholder={`Type, or push ${pluralOf('note')} in`}
        onChange={(e) => onTextChange(e.target.value)}
      />

      <div className="pb-sent">
        <span className="pb-sent-label">Sent to the model</span>
        <div className="pb-sent-body">
          {parts.length ? (
            parts.map((p, i) => (
              <span key={i} className={p.kind === 'plain' ? undefined : `pb-tok ${p.kind}`}>
                {p.text}
              </span>
            ))
          ) : (
            <span className="pb-empty">Empty prompt</span>
          )}
        </div>
        {dangling.length > 0 && (
          <span className="pb-dangling">
            {dangling.join(', ')} {dangling.length > 1 ? 'point' : 'points'} past the end of the basket — add an item
            or edit the text.
          </span>
        )}
      </div>
    </div>
  );
}
