import { useEffect } from 'react';

/**
 * Bottom sheet. Rises from the thumb rather than dropping from the top, because
 * everything in this app is reachable one-handed by design.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="row between" style={{ marginBottom: 10 }}>
          <strong>{title}</strong>
          <button className="btn small ghost" onClick={onClose}>Done</button>
        </div>
        {children}
      </div>
    </div>
  );
}
