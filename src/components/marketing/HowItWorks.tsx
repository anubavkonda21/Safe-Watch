import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';

/** The real flow, step by step. Every step works today; where it differs between a file and a YouTube link, the step says so. */
const STEPS = [
  { title: 'Choose', body: 'Pick a video file from your device, or paste a YouTube link. Add the words or phrases you want to find.', note: 'Works for both' },
  { title: 'Check', body: 'For a file, your words are matched against its speech and subtitles. For YouTube, against a caption file you add: SafeWatch cannot hear or see a YouTube video.', note: 'Speech: files only' },
  { title: 'Review', body: 'Matches are listed with their times and how exact those times are. There is no score and no verdict.', note: 'Works for both' },
  { title: 'Watch', body: 'Optional warnings (tap the X, press Escape or swipe one away), mute or skip, and a +10 s button. Nothing happens unless you choose it.', note: 'Works for both' },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="sw-section" aria-labelledby="how-title">
      <Container>
        <div className="sw-section__head">
          <h2 id="how-title" className="sw-h1">How it works</h2>
          <p className="sw-body-lg sw-muted">What happens today, step by step.</p>
        </div>
        <ol className="sw-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="sw-step">
              <span className="sw-step__num">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="sw-h3">{s.title}</h3>
              <p className="sw-body-sm sw-muted">{s.body}</p>
              <Badge tone="accent">{s.note}</Badge>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
