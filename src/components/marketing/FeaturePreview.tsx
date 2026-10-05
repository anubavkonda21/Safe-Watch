import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Container } from '@/components/ui/Container';
import { ControlIcon, DetectIcon, UnderstandIcon } from '@/components/ui/icons';

const FEATURES: ReadonlyArray<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <UnderstandIcon />, title: 'Understand', body: 'Reads speech, subtitles and scenes together, so context decides what a moment really is.' },
  { icon: <DetectIcon />, title: 'Detect', body: 'Finds the moments that matter to you and places them on a timeline before you press play.' },
  { icon: <ControlIcon />, title: 'Control', body: 'Mute, mask or skip what you choose. Your policy decides, not a one-size-fits-all rating.' },
];

export function FeaturePreview() {
  return (
    <section id="product" className="sw-section" aria-labelledby="product-title">
      <Container>
        <div className="sw-section__head">
          <Badge>Planned capabilities</Badge>
          <h2 id="product-title" className="sw-h1">Three ideas, one player</h2>
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
