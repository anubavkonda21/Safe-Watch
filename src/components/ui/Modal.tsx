import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';
import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Built on the native <dialog>: focus trapping, Escape to close and inert
 * background come from the platform.
 */
export function Modal({ open, title, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // Backdrop click is a pointer convenience; keyboard users close via Escape or the close button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={ref}
      className="sw-modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="sw-modal__panel">
        <div className="sw-modal__head">
          <h2 id={titleId} className="sw-h3">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}><CloseIcon size={18} /></IconButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}
