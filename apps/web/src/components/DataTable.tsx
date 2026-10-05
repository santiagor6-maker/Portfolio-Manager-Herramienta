import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string | undefined;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerTitle?: string;
  /** Sticky first column on small screens. */
  sticky?: boolean;
  footer?: ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  onRowClick,
  selectable,
  selected,
  onSelectedChange,
  caption,
  maxHeight,
  footer,
  rowClassName,
  empty,
  testId,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  caption: string;
  maxHeight?: number | string;
  footer?: boolean;
  rowClassName?: (row: T) => string | undefined;
  empty?: ReactNode;
  testId?: string;
}) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va === vb) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return (va < vb ? -1 : 1) * dir;
    });
  }, [rows, sort, columns]);

  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(rowKey(r)));

  return (
    <div className="overflow-auto rounded-b-xl" style={{ maxHeight }} data-testid={testId}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {selectable && (
              <th className="w-8 !pr-0">
                <input
                  type="checkbox"
                  aria-label="Seleccionar todo"
                  checked={!!allSelected}
                  onChange={(e) => onSelectedChange?.(new Set(e.target.checked ? rows.map(rowKey) : []))}
                />
              </th>
            )}
            {columns.map((c) => {
              const active = sort?.id === c.id;
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined;
              return (
                <th
                  key={c.id}
                  aria-sort={ariaSort}
                  title={c.headerTitle}
                  className={clsx(
                    c.align === 'right' && 'r',
                    c.align === 'center' && 'text-center',
                    c.sticky && 'sm:static sticky left-0 z-[2]',
                    c.className,
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      className={clsx(
                        'inline-flex items-center gap-1 uppercase tracking-[0.03em] hover:text-ink',
                        active && 'text-ink',
                        c.align === 'right' && 'flex-row-reverse',
                      )}
                      onClick={() =>
                        setSort((s) =>
                          s?.id === c.id ? { id: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { id: c.id, dir: c.align === 'right' ? 'desc' : 'asc' },
                        )
                      }
                    >
                      {c.header}
                      {active ? (
                        sort!.dir === 'asc' ? (
                          <ArrowUp size={12} aria-hidden />
                        ) : (
                          <ArrowDown size={12} aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown size={12} className="opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)} className="!py-10 text-center text-muted">
                {empty ?? '—'}
              </td>
            </tr>
          )}
          {sorted.map((r) => {
            const key = rowKey(r);
            const isSel = selected?.has(key);
            return (
              <tr
                key={key}
                className={clsx(onRowClick && 'cursor-pointer', isSel && '[&>td]:!bg-accent-soft', rowClassName?.(r))}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') onRowClick(r);
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
              >
                {selectable && (
                  <td className="w-8 !pr-0" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar ${key}`}
                      checked={!!isSel}
                      onChange={(e) => {
                        const n = new Set(selected);
                        if (e.target.checked) n.add(key);
                        else n.delete(key);
                        onSelectedChange?.(n);
                      }}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={clsx(
                      c.align === 'right' && 'r num',
                      c.align === 'center' && 'text-center',
                      c.sticky && 'sticky sm:static left-0 bg-surface z-[1]',
                      c.className,
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && (
          <tfoot>
            <tr>
              {selectable && <td />}
              {columns.map((c) => (
                <td
                  key={c.id}
                  className={clsx(
                    'font-semibold bg-surface-2 border-t border-line',
                    c.align === 'right' && 'r num',
                    c.sticky && 'sticky sm:static left-0 z-[1]',
                  )}
                >
                  {c.footer}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
