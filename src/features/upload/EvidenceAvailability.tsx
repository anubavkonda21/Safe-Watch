import type { ContextAnalysis, InputStatus } from '@/domain/context/contextAnalysis';

const TEXT: Record<InputStatus, string> = {
  used: 'available',
  empty: 'none found',
  failed: 'could not be read',
  'not-enabled': 'not enabled on this server',
  pending: 'checking…',
};

/**
 * Which kinds of evidence exist for THIS video, in the words the system really has: available, none found, could not be read, not
 * enabled, still checking. It says nothing about whether the video is acceptable.
 */
export function EvidenceAvailability({ context }: { context: ContextAnalysis | null }) {
  const inputs = context?.inputs ?? { speech: 'pending', subtitles: 'pending', visual: 'pending' } as const;
  const rows: Array<[string, InputStatus]> = [['Speech', inputs.speech], ['Subtitles', inputs.subtitles], ['Visual evidence', inputs.visual]];
  return (
    <dl className="sw-evidence" aria-label="Evidence available for this video">
      {rows.map(([label, status]) => (
        <div key={label} className={`sw-evidence__item is-${status}`}>
          <dt className="sw-caption">{label}</dt>
          <dd className="sw-body-sm">{TEXT[status]}</dd>
        </div>
      ))}
    </dl>
  );
}
