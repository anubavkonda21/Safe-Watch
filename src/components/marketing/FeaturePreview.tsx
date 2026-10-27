import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { ControlIcon, DetectIcon, UnderstandIcon } from '@/components/ui/icons';

/** What the product does today, in the words the rest of the interface uses. Nothing here is planned work. */
const FEATURES: ReadonlyArray<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <DetectIcon />, title: 'Find', body: 'Finds your words and phrases in the speech of a video file (recognised on your own machine, when speech recognition is set up) and in its subtitles, or in a caption file you add for a YouTube video.' },
  { icon: <UnderstandIcon />, title: 'Warn', body: 'Shows a heads-up about 20 seconds before a match, and says plainly when a match was found too late to warn in time.' },
  { icon: <ControlIcon />, title: 'Control', body: 'Mutes or skips a match while you watch, but only if you choose it, and a +10 s button jumps ahead whenever you want. By default nothing happens.' },
];

export function FeaturePreview() {
  return (
    <section id="product" className="sw-section" aria-labelledby="product-title">
      <Container>
        <div className="sw-section__head">
          <Badge>Early version</Badge>
          <h2 id="product-title" className="sw-h1">What it does today</h2>
          <p className="sw-body-lg sw-muted">Not supported: detecting sexual content, violence, graphic injury or drug-related scenes. SafeWatch does not do this.</p>
        </div>
        <ul className="sw-features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <Card hoverable className="sw-feature">
                <span className="sw-feature__icon">{f.icon}</span>
                <h3 className="sw-h3">{f.title}</h3>
                <p className="sw-body-sm sw-muted">{f.body}</p>
              </Card>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
