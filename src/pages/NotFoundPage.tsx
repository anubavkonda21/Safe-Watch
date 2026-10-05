import { Link } from 'react-router-dom';
import { Container } from '@/components/ui/Container';

export function NotFoundPage() {
  return (
    <main className="sw-notfound">
      <Container>
        <p className="sw-label sw-muted">404</p>
        <h1 className="sw-h1">Page not found</h1>
        <p className="sw-body sw-muted">The page you are looking for does not exist.</p>
        <Link className="sw-btn sw-btn--secondary sw-btn--md" to="/">Back to SafeWatch</Link>
      </Container>
    </main>
  );
}
