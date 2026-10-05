import { Container } from '@/components/ui/Container';

export function SafetySection() {
  return (
    <section id="safety" className="sw-section" aria-labelledby="safety-title">
      <Container className="sw-prose-grid">
        <h2 id="safety-title" className="sw-h1">Built around your choices</h2>
        <div className="sw-prose">
          <p className="sw-body-lg sw-muted">
            SafeWatch is designed so that you define what is acceptable. Analysis should be transparent about what it found and how confident it is.
          </p>
          <p className="sw-body-lg sw-muted">
            In this early foundation, videos you select are checked and read locally in your browser. Nothing is uploaded.
          </p>
        </div>
      </Container>
    </section>
  );
}

export function AboutSection() {
  return (
    <section id="about" className="sw-section" aria-labelledby="about-title">
      <Container className="sw-prose-grid">
        <h2 id="about-title" className="sw-h1">About SafeWatch</h2>
        <div className="sw-prose">
          <p className="sw-body-lg sw-muted">
            SafeWatch is an early-stage project working toward an intelligent media-safety platform. The interface and architecture are in place; the analysis engine is not built yet.
          </p>
        </div>
      </Container>
    </section>
  );
}
