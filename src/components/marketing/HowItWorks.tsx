import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';

const STEPS = [
  { title: 'Upload', body: 'Choose a video from your device.', status: 'preview' },
  { title: 'Analyze', body: 'Speech, subtitles and frames are processed.', status: 'planned' },
  { title: 'Review', body: 'See a safety timeline and pre-playback summary.', status: 'planned' },
  { title: 'Watch', body: 'Play with your filters applied.', status: 'planned' },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="sw-section" aria-labelledby="how-title">
      <Container>
        <div className="sw-section__head">
          <h2 id="how-title" className="sw-h1">How it works</h2>
          <p className="sw-body-lg sw-muted">The intended flow. Only the first step has a preview today.</p>
        </div>
        <ol className="sw-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="sw-step">
              <span className="sw-step__num">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="sw-h3">{s.title}</h3>
              <p className="sw-body-sm sw-muted">{s.body}</p>
              <Badge tone={s.status === 'preview' ? 'accent' : 'neutral'}>{s.status}</Badge>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
