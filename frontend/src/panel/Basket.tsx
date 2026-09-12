// A reference basket — see hooks/basket.ts for the model.
//
// Header (title, count, collapse), then one 27px row per item: grab handle,
// thumbnail, @token, board title, remove. Then an Add button that says what it
// will take ("Add 3 images"), and a ⋯ for the other ways in.
//
// Reorder is drag-only. The handle is the affordance, and dropping up/down
// arrows buys back ~30px of row width for the title — which matters at 300px.
// The @token is the primary identifier rather than the filename, because
// position is the meaning: the models take a flat array with no notion of a
// subject, so "@Image2" is what the prompt actually refers to.

import { useEffect, useRef, useState } from 'react';
import { pluralOf, quantity, type Basket, type BasketItem } from './hooks/basket';

const TOKEN: Record<string, string> = { image: 'Image', video: 'Video', audio: 'Audio' };
const GLYPH: Record<string, string> = { image: '', video: '▶', audio: '≈' };

function GrabIcon() {
  return (
    <svg width="9" height="12" viewBox="0 0 9 12" fill="currentColor" className="bk-grab" aria-hidden="true">
      <circle cx="2" cy="2" r="1" /><circle cx="7" cy="2" r="1" />
      <circle cx="2" cy="6" r="1" /><circle cx="7" cy="6" r="1" />
      <circle cx="2" cy="10" r="1" /><circle cx="7" cy="10" r="1" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function DotsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export function BasketPanel({
  basket,
  title,
  /** Insert this row's token into the prompt — omitted when nothing consumes tokens. */
  onInsertToken,
  /** Show @Image1-style tokens. Off for models that don't address by name. */
  showTokens = true,
  /**
   * How this model writes the token for row `index` (0-based). Defaults to
   * `@Image1`, which is Seedance's and Kling's form — but MiniMax wants
   * `Image 1`, Happy Horse `character1` and Grok `<IMAGE_0>`, and a chip that
   * shows the wrong one is worse than no chip: it is the text people click to
   * build the prompt.
   */
  tokenFor,
  cap,
}: {
  basket: Basket;
  title: string;
  onInsertToken?: (token: string) => void;
  showTokens?: boolean;
  tokenFor?: (index: number) => string;
  cap?: number;
}) {
  const { kind, items, selectionCount, hasMissing, undo, loading } = basket;
  const token = tokenFor ?? ((i: number) => `@${TOKEN[kind] ?? 'Item'}${i + 1}`);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);

  // Anything that just arrived should be visible: you pressed Add to put items
  // in, so hiding them behind a "show all" is the wrong default. Expands on any
  // growth, which covers Add, connectors, the frame, a pasted URL, and a
  // reopened card's pre-fill alike.
  const prevCount = useRef(items.length);
  useEffect(() => {
    if (items.length > prevCount.current) setCollapsed(false);
    prevCount.current = items.length;
  }, [items.length]);

  // Collapsing hides the rows entirely rather than leaving a couple behind —
  // a partly-folded list reads as "something is missing" rather than "this is
  // put away". A basket with a problem in it refuses to fold at all.
  const canCollapse = items.length > 0 && !hasMissing;
  const folded = canCollapse && collapsed;
  const shown = folded ? [] : items;

  const overCap = cap != null && items.length > cap;

  const onDragEnter = (i: number) => {
    if (drag == null || drag === i) return;
    basket.move(drag, i);
    setDrag(i);
  };

  return (
    <div className="bk">
      <div className="bk-head">
        <span className="bk-title">{title}</span>
        <span className={`bk-count ${hasMissing || overCap ? 'warn' : ''}`}>{items.length}</span>
        {canCollapse && (
          <button type="button" className="bk-ghost" onClick={() => setCollapsed((v) => !v)}>
            {folded ? `Show ${items.length}` : 'Collapse'}
          </button>
        )}
      </div>

      {shown.length > 0 && (
        <div className="bk-rows">
          {shown.map((it, i) => (
            <Row
              key={it.uid}
              item={it}
              kind={kind}
              token={token(i)}
              showToken={showTokens}
              dragging={drag === i}
              onDragStart={() => setDrag(i)}
              onDragEnter={() => onDragEnter(i)}
              onDragEnd={() => setDrag(null)}
              onRemove={() => basket.remove(it.uid)}
              onToken={onInsertToken ? () => onInsertToken(token(i)) : undefined}
            />
          ))}
        </div>
      )}

      {items.length === 0 && (
        <div className="bk-empty">
          Nothing here yet. Select {pluralOf(kind)} on the board and press Add — order is what the prompt refers to.
        </div>
      )}

      {hasMissing && (
        <div className="bk-warn">
          <span>Some items are no longer on the board.</span>
          <button type="button" onClick={basket.removeMissing}>
            Remove them
          </button>
        </div>
      )}

      {overCap && <div className="bk-warn plain">This model takes {cap} — the extras won't be sent.</div>}

      {/* Collapsed means "put away", so the transient action line goes with the
          rows. The cap warning below stays: that is a standing fact about what
          will be sent, not a thing that just happened. Undo is still there
          when you expand. */}
      {undo && !folded && (
        <div className="bk-undo">
          <span>{undo.text}</span>
          <button type="button" onClick={basket.applyUndo}>
            Undo
          </button>
        </div>
      )}

      <div className="bk-actions">
        <button
          type="button"
          className={`bk-add ${selectionCount ? 'on' : ''}`}
          onClick={basket.addSelection}
          disabled={!selectionCount || loading}
        >
          <PlusIcon />
          <span>{selectionCount ? `Add ${quantity(selectionCount, kind)}` : `Select ${pluralOf(kind)} to add`}</span>
        </button>
        <button
          type="button"
          className={`bk-dots ${menuOpen ? 'on' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More ways to add"
          aria-expanded={menuOpen}
        >
          <DotsIcon />
        </button>

        {menuOpen && (
          <BasketMenu
            basket={basket}
            onClose={() => setMenuOpen(false)}
            oneSelected={basket.selectionCount >= 0}
          />
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  kind,
  showToken,
  dragging,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onRemove,
  onToken,
  token,
}: {
  item: BasketItem;
  kind: string;
  token: string;
  showToken: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onRemove: () => void;
  onToken?: () => void;
}) {
  return (
    <div
      className={`bk-row ${item.missing ? 'missing' : ''} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
    >
      <GrabIcon />
      <span className={`bk-thumb ${kind}`}>{GLYPH[kind] ?? ''}</span>
      {showToken &&
        (onToken ? (
          <button type="button" className="bk-token" onClick={onToken} title="Insert into the prompt">
            {token}
          </button>
        ) : (
          <span className="bk-token static">{token}</span>
        ))}
      <span className="bk-label">{item.label || '(untitled — name it on the board)'}</span>
      <button type="button" className="bk-x" onClick={onRemove} aria-label={`Remove ${item.label || 'item'}`}>
        <XIcon />
      </button>
    </div>
  );
}

/** The other ways in. Always present, so connectors stay findable. */
function BasketMenu({ basket, onClose }: { basket: Basket; onClose: () => void; oneSelected?: boolean }) {
  const [urlMode, setUrlMode] = useState(false);
  const [url, setUrl] = useState('');
  const canConnectors = basket.selectionCount >= 0;

  if (urlMode) {
    return (
      <div className="bk-menu">
        <input
          className="bk-url"
          autoFocus
          value={url}
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              basket.addUrl(url);
              onClose();
            }
            if (e.key === 'Escape') setUrlMode(false);
          }}
        />
        <button
          type="button"
          onClick={() => {
            basket.addUrl(url);
            onClose();
          }}
        >
          <span className="bk-menu-label">Add this URL</span>
        </button>
      </div>
    );
  }

  return (
    <div className="bk-menu" role="menu">
      <button
        type="button"
        disabled={!canConnectors}
        onClick={() => {
          void basket.addFromConnectors();
          onClose();
        }}
      >
        <span className="bk-menu-label">Add from connectors</span>
        <span className="bk-menu-note">the selected item, plus everything wired to it</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void basket.addFromFrame();
          onClose();
        }}
      >
        <span className="bk-menu-label">Add everything on the frame</span>
        <span className="bk-menu-note">all {pluralOf(basket.kind)} inside the selected frame</span>
      </button>
      <button type="button" onClick={() => setUrlMode(true)}>
        <span className="bk-menu-label">Paste a URL</span>
        <span className="bk-menu-note">no board item needed</span>
      </button>
    </div>
  );
}
