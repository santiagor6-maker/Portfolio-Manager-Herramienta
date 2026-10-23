/**
 * W51: wide tables fit their card instead of hiding columns behind a horizontal scroll bar that only
 * shows at the bottom of 100 rows. Columns carry a priority (`dropOrder`, least important first): while
 * the table is wider than its box, the next one is hidden. A note names what was hidden and offers
 * "Mostrar todas" (then the box scrolls horizontally, as before). Widths are re-fitted on resize.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function useFitColumns<K extends string>(dropOrder: K[], resetKey: unknown) {
  // Callback ref: the box may mount after the first render (empty state → table).
  const [box, ref] = useState<HTMLElement | null>(null);
  const [hidden, setHidden] = useState<K[]>([]);
  const [showAll, setShowAll] = useState(false);
  // Print shows every chosen column (the note naming hidden ones is not printed).
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const on = () => setPrinting(true);
    const off = () => setPrinting(false);
    window.addEventListener('beforeprint', on);
    window.addEventListener('afterprint', off);
    return () => {
      window.removeEventListener('beforeprint', on);
      window.removeEventListener('afterprint', off);
    };
  }, []);
  const order = dropOrder.join('|');

  // Start over when the content or the available columns change.
  useEffect(() => setHidden([]), [resetKey, order]);

  // Before paint: hide one more column while the table overflows (each pass re-renders synchronously).
  useLayoutEffect(() => {
    const table = box?.querySelector('table');
    if (!box || !table || showAll || printing) return;
    if (table.scrollWidth > box.clientWidth + 1) {
      const next = dropOrder.find((k) => !hidden.includes(k));
      if (next) setHidden((h) => (h.includes(next) ? h : [...h, next]));
    }
  });

  // A wider (or narrower) box: fit again from all columns.
  const width = useRef(0);
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      // A scrollbar appearing or vanishing (≈ 15 px) is not a new layout: no re-fit, no flicker loop.
      if (Math.abs(w - width.current) > 24) {
        width.current = w;
        setHidden([]);
      }
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const all = showAll || printing;
  return { ref, hidden: all ? new Set<K>() : new Set(hidden), hiddenList: all ? [] : hidden, showAll, setShowAll };
}

/** "Columnas ocultas por espacio: … · Mostrar todas" (or "Ajustar al ancho" when all are shown). */
export function HiddenColumnsNote({ labels, showAll, onToggle }: { labels: string[]; showAll: boolean; onToggle: (v: boolean) => void }) {
  const { t } = useTranslation();
  if (!labels.length && !showAll) return null;
  return (
    <p className="px-4 py-1.5 text-xs text-muted border-b border-line print:hidden" data-testid="hidden-columns">
      {showAll ? t('table.allShown') : t('table.hidden', { columns: labels.join(', ') })}{' '}
      <button type="button" className="text-accent hover:underline" onClick={() => onToggle(!showAll)}>
        {showAll ? t('table.fit') : t('table.showAll')}
      </button>
    </p>
  );
}
