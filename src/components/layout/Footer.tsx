import { Container } from '@/components/ui/Container';

export function Footer() {
  return (
    <footer className="sw-footer">
      <Container className="sw-footer__row">
        <span>© {new Date().getFullYear()} SafeWatch</span>
        <span>Early foundation — analysis features are not yet available.</span>
      </Container>
    </footer>
  );
}
