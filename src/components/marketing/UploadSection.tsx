import { Container } from '@/components/ui/Container';
import { UploadDropzone } from '@/features/upload/UploadDropzone';

export function UploadSection() {
  return (
    <section id="analyze" className="sw-section" aria-labelledby="analyze-title">
      <Container>
        <div className="sw-section__head sw-section__head--center">
          <h2 id="analyze-title" className="sw-h1">Start with a video</h2>
          <p className="sw-body-lg sw-muted">The first step of the analysis workflow.</p>
        </div>
        <UploadDropzone />
      </Container>
    </section>
  );
}
