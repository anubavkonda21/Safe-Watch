import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Alert } from './Alert';
import { Badge } from './Badge';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { Modal } from './Modal';
import { Progress } from './Progress';
import { Select } from './Select';
import { Tooltip } from './Tooltip';

describe('Button', () => {
  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).not.toHaveBeenCalled();
  });
  it('is disabled and busy while loading', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
  it('is reachable and activatable by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Go' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('uses its label as the accessible name', () => {
    render(<IconButton label="Close"><span /></IconButton>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('Input', () => {
  it('associates label, hint and error', () => {
    const { rerender } = render(<Input label="Email" hint="We never share it" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAccessibleDescription('We never share it');
    expect(input).not.toHaveAttribute('aria-invalid');
    rerender(<Input label="Email" hint="We never share it" error="Required" />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Required');
  });
});

describe('Select', () => {
  it('is labelled and changes value', async () => {
    render(<Select label="Preset" options={[{ value: 'a', label: 'Strict' }, { value: 'b', label: 'Relaxed' }]} />);
    const select = screen.getByLabelText('Preset');
    await userEvent.selectOptions(select, 'b');
    expect(select).toHaveValue('b');
  });
});

describe('Alert', () => {
  it('uses alert role for danger and status for info', () => {
    const { rerender } = render(<Alert tone="danger" title="Bad" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Bad');
    rerender(<Alert tone="info" title="FYI" />);
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
  });
});

describe('Progress', () => {
  it('reports determinate value and omits it when indeterminate', () => {
    const { rerender } = render(<Progress label="Work" value={40} />);
    expect(screen.getByRole('progressbar', { name: 'Work' })).toHaveAttribute('aria-valuenow', '40');
    rerender(<Progress label="Work" />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
});

describe('Tooltip', () => {
  it('describes the wrapped control', () => {
    render(<Tooltip text="Helpful"><button>Hi</button></Tooltip>);
    expect(screen.getByRole('button', { name: 'Hi' })).toHaveAccessibleDescription('Helpful');
  });
});

describe('Badge', () => {
  it('renders its content', () => {
    render(<Badge tone="success">Done</Badge>);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

describe('Modal', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Modal open={open} title="Settings" onClose={() => setOpen(false)}>Body</Modal>
      </>
    );
  }
  it('opens, is labelled by its title, and closes via the close button', async () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
