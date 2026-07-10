import { useState } from 'react';

// Self-hosted provider (AI-lab) logo chips for the "browse by Provider" tiles.
//
// `mark` = a real lab logo (light-on-transparent art, shown contained on a dark
// chip). `badge` = an original monogram fallback (full-bleed coloured tile) for
// labs we don't have official art for yet. Drop a real logo into /public/logos
// and switch its entry to `mark` to upgrade it. Falls back to the provider's
// initial if the file is missing. No external requests.

type Logo = { src: string; style: 'mark' | 'badge' };

const PROVIDER_LOGOS: Record<string, Logo> = {
  Google: { src: '/logos/google.png', style: 'mark' },
  ByteDance: { src: '/logos/bytedance.png', style: 'mark' },
  'Black Forest Labs': { src: '/logos/bfl.png', style: 'mark' },
  Tencent: { src: '/logos/tencent.png', style: 'mark' },
  Meta: { src: '/logos/meta.svg', style: 'badge' },
  'Stability AI': { src: '/logos/stability.svg', style: 'badge' },
  Meshy: { src: '/logos/meshy.svg', style: 'badge' },
  Fal: { src: '/logos/fal.svg', style: 'badge' },
};

export function ProviderLogo({ provider }: { provider: string }) {
  const [failed, setFailed] = useState(false);
  const logo = failed ? undefined : PROVIDER_LOGOS[provider];

  if (logo) {
    return (
      <span className={`tile-icon tile-icon-logo ${logo.style}`}>
        <img src={logo.src} alt={`${provider} logo`} onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className="tile-icon tile-icon-neutral">{provider.charAt(0)}</span>;
}
