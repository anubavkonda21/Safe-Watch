import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { YouTubePanel } from './YouTubePanel';
import type { ReactNode } from 'react';

export type SourceKind = 'local' | 'youtube';

const TABS: Array<{ id: SourceKind; label: string }> = [
  { id: 'local', label: 'Local file' },
  { id: 'youtube', label: 'YouTube' },
];

interface Props {
  /** The existing local-file experience, unchanged. It is unmounted when the other source is chosen, so nothing it was playing keeps going. */
  local: ReactNode;
  initial?: SourceKind;
}

/**
 * Chooses WHERE the video comes from. Only the chosen source is mounted: switching discards the other source's player, warnings,
 * findings and choices instead of hiding them (a hidden player would keep playing). Keyboard: arrow keys, Home and End move
 * between the two tabs, as in the WAI-ARIA tabs pattern.
 */
export function SourceSelector({ local, initial = 'local' }: Props) {
  const [source, setSource] = useState<SourceKind>(initial);
  const base = useId();
  const refs = useRef<Record<SourceKind, HTMLButtonElement | null>>({ local: null, youtube: null });

  const move = (e: KeyboardEvent, from: number) => {
    let to = from;
    if (e.key === 'ArrowRight') to = (from + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (from - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    else return;
    e.preventDefault();
    const next = TABS[to]!.id;
    setSource(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="sw-source">
      <div role="tablist" aria-label="Where is the video?" className="sw-source__tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id} ref={(el) => { refs.current[t.id] = el; }} type="button" role="tab" id={`${base}-${t.id}`} aria-selected={source === t.id} aria-controls={`${base}-panel`}
            tabIndex={source === t.id ? 0 : -1} className={cn('sw-source__tab', source === t.id && 'is-active')}
            onClick={() => setSource(t.id)} onKeyDown={(e) => move(e, i)}
          >{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${source}`} className="sw-source__panel">
        {source === 'local' ? local : <YouTubePanel />}
      </div>
    </div>
  );
}
