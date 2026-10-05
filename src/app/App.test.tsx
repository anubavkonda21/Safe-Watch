import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { App } from './App';

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe('application boot', () => {
  it('renders the home page with the product headline and landmarks', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Understand your media.');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('exposes the primary navigation and CTA', () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const name of ['Product', 'How it works', 'Safety', 'About']) {
      expect(nav).toHaveTextContent(name);
    }
    expect(screen.getAllByRole('link', { name: 'Analyze a Video' })[0]).toHaveAttribute('href', '#analyze');
  });

  it('renders the three capability cards', () => {
    renderAt('/');
    for (const t of ['Understand', 'Detect', 'Control']) {
      expect(screen.getByRole('heading', { level: 3, name: t })).toBeInTheDocument();
    }
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nope');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('toggles the mobile menu with correct aria state', async () => {
    renderAt('/');
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
  });
});
