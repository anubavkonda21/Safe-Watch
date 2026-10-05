import { useState } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { IconButton } from '@/components/ui/IconButton';
import { CloseIcon, MenuIcon } from '@/components/ui/icons';
import { Wordmark } from './Wordmark';

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#safety', label: 'Safety' },
  { href: '#about', label: 'About' },
] as const;

export function Navigation() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="sw-nav">
      <Container>
        <nav className="sw-nav__bar" aria-label="Primary">
          <Wordmark />
          <ul className="sw-nav__links">
            {LINKS.map((l) => (
              <li key={l.href}><a className="sw-nav__link" href={l.href}>{l.label}</a></li>
            ))}
          </ul>
          <ButtonLink href="#analyze" className="sw-nav__cta">Analyze a Video</ButtonLink>
          <IconButton
            label={open ? 'Close menu' : 'Open menu'}
            className="sw-nav__toggle"
            aria-expanded={open}
            aria-controls="sw-nav-panel"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </IconButton>
        </nav>
        <div id="sw-nav-panel" className="sw-nav__panel" data-open={open}>
          {LINKS.map((l) => (
            <a key={l.href} className="sw-nav__link" href={l.href} onClick={close}>{l.label}</a>
          ))}
          <ButtonLink href="#analyze" onClick={close}>Analyze a Video</ButtonLink>
        </div>
      </Container>
    </header>
  );
}
