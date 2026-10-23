import { Badge } from '@/components/ui/Badge';
import { ACCEPTED_VIDEO_EXTENSIONS } from '@/domain/media/validation';
import { TAXONOMY } from '@/domain/safety/taxonomy';

/**
 * A short, honest "what this does today" card. It states the one supported check and the unsupported ones in plain words, and
 * that finding nothing does not mean a video is safe. It repeats nothing the interface already says at the point of use.
 */
export function ProductGuide() {
  const unsupported = TAXONOMY.filter((c) => c.support === 'unsupported').map((c) => c.label.toLowerCase());
  return (
    <aside className="sw-guide" aria-labelledby="guide-title">
      <h3 id="guide-title" className="sw-label sw-muted">What SafeWatch does today</h3>
      <ol className="sw-guide__steps">
        <li><strong>Choose a video.</strong> <span className="sw-muted">Formats: {ACCEPTED_VIDEO_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.</span></li>
        <li><strong>Add words or phrases</strong> <span className="sw-muted">under Custom filters.</span></li>
        <li><strong>Review the findings</strong> <span className="sw-muted">where those phrases occur in the speech and subtitles.</span></li>
        <li><strong>Watch with a heads-up.</strong> <span className="sw-muted">Choose Skip or Ignore when a warning appears, or set an action for each finding.</span></li>
      </ol>
      <div className="sw-guide__limits">
        <p className="sw-body-sm"><Badge tone="success">Supported</Badge> Your own words and phrases, in speech and subtitles.</p>
        <p className="sw-body-sm"><Badge tone="neutral">Not supported yet</Badge> {unsupported.join(', ')}. SafeWatch does not detect these.</p>
        <p className="sw-caption sw-muted">
          Finding nothing does not mean a video is safe: SafeWatch only looks for the phrases you list, in text it could read. Frame descriptions are evidence only, not a safety judgement. Reports of missed phrases are notes saved on your device; they do not train SafeWatch.
        </p>
      </div>
    </aside>
  );
}
