import { useEffect, useState } from 'react';
import { api, connectionMode } from '../lib/api';

/**
 * Remaining Fal credit balance, shown top-right (like the Runway/11L apps).
 * In client mode there's no backend to ask (getBalance needs ADMIN_KEY), so
 * this shows a "$?" placeholder with a hover explanation instead of silently
 * failing — with a direct link back to Settings for anyone who wants the
 * badge back.
 */
export function CreditsBadge({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [text, setText] = useState('…');
  const [showTip, setShowTip] = useState(false);
  const isClient = connectionMode() === 'client';

  useEffect(() => {
    if (isClient) return;
    let mounted = true;
    api
      .getBalance()
      .then((b) => {
        if (!mounted) return;
        setText(b.balance != null ? `${b.currency === 'USD' ? '$' : ''}${b.balance.toFixed(2)}` : '—');
      })
      .catch(() => mounted && setText('—'));
    return () => {
      mounted = false;
    };
  }, [isClient]);

  if (isClient) {
    return (
      <span className="credits-wrap" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
        <span className="credits credits-unknown">$?</span>
        {showTip && (
          <span className="credits-tip">
            <span className="credits-tip-box">
              <span>
                Your credit balance isn't readable from the browser — it needs a backend to ask Fal
                on your behalf.
              </span>
              {onOpenSettings && (
                <button
                  type="button"
                  className="credits-tip-link"
                  onClick={() => {
                    setShowTip(false);
                    onOpenSettings();
                  }}
                >
                  Switch to backend mode →
                </button>
              )}
            </span>
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="credits" title="Fal credit balance">
      {text}
    </span>
  );
}
