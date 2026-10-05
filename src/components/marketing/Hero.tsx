import { ButtonLink } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { AnalysisVisual } from './AnalysisVisual';

export function Hero() {
  return (
    <section className="sw-hero" aria-labelledby="hero-title">
      <Container className="sw-hero__grid">
        <div className="sw-hero__copy">
          <p className="sw-label sw-hero__eyebrow">AI-powered media safety</p>
          <h1 id="hero-title" className="sw-display">
            Understand your media.<br />Control your experience.
          </h1>
          <p className="sw-body-lg sw-muted sw-hero__lede">
            SafeWatch looks inside a video to understand what is happening, then lets you decide what you are willing to see and hear.
          </p>
          <div className="sw-hero__actions">
            <ButtonLink href="#analyze" size="lg">Analyze a Video</ButtonLink>
            <ButtonLink href="#how-it-works" size="lg" variant="secondary">How it works</ButtonLink>
          </div>
        </div>
        <div className="sw-hero__visual"><AnalysisVisual /></div>
      </Container>
    </section>
  );
}
