import { ButtonLink } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { AnalysisVisual } from './AnalysisVisual';

export function Hero() {
  return (
    <section className="sw-hero" aria-labelledby="hero-title">
      <Container className="sw-hero__grid">
        <div className="sw-hero__copy">
          <p className="sw-label sw-hero__eyebrow">Media safety on your terms</p>
          <h1 id="hero-title" className="sw-display">
            Understand your media.<br />Control your experience.
          </h1>
          <p className="sw-body-lg sw-muted sw-hero__lede">
            Choose the words and phrases you would rather not hear. SafeWatch finds them in a video’s speech and captions, warns you ahead of time, and can mute or skip them while you watch.
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
