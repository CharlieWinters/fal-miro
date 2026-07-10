import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Remaining Fal credit balance, shown top-right (like the Runway/11L apps). */
export function CreditsBadge() {
  const [text, setText] = useState('…');

  useEffect(() => {
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
  }, []);

  return (
    <span className="credits" title="Fal credit balance">
      {text}
    </span>
  );
}
