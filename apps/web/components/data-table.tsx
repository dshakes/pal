"use client";
// DataTable (v3). Sortable columns with aria-sort, sticky header, density-aware
// rows (--row-h / --cell-* from <html data-density>), keyboard row navigation
// (↑/↓ between rows, Enter opens), and its own loading + empty states. Pages
// pass real API rows only — there is no sample data anywhere in apps/web.

import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eye, Inbox } from "lucide-react";
import clsx from "clsx";

export interface Column<T> {
  key: string;
  header: string;
  /** Keep the header for screen readers only (action columns). */
  headerHidden?: boolean;
  render: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
  sortFn?: (a: T, b: T) => number;
  width?: number;
  minWidth?: number;
  align?: "left" | "right";
  /** Hide below the md breakpoint so phones keep the essential columns. */
  hideOnMobile?: boolean;
}

interface RowAction<T> {
  label: string;
  icon: typeof Eye;
  onClick: (row: T) => void;
  variant?: "default" | "danger";
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
  /** 0 disables paging. */
  pageSize?: number;
  rowActions?: RowAction<T>[];
  loading?: boolean;
  /** Accessible name for the table. */
  label?: string;
  /** Fixed layout: columns with `width` keep it, the rest share what's left, so long cells truncate instead of widening the table. */
  fixed?: boolean;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyIcon?: typeof Inbox;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}

type SortDir = "asc" | "desc";

export function DataTable<T>({
  columns,
  rows,
  onRowClick,
  rowKey,
  pageSize = 10,
  rowActions,
  loading = false,
  label,
  fixed = false,
  defaultSort,
  emptyIcon: EmptyIcon = Inbox,
  emptyTitle = "Nothing here yet",
  emptyDescription = "There are no items to display.",
  emptyAction,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);
  const [page, setPage] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortFn) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => col.sortFn!(a, b) * dir);
  }, [rows, sort, columns]);

  const paged = pageSize > 0;
  const totalPages = paged ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, totalPages - 1);
  const visible = paged ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted;

  const toggleSort = useCallback((key: string) => {
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  }, []);

  const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const rowsEls = Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[tabindex]") ?? []);
    const i = rowsEls.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") { e.preventDefault(); rowsEls[i + 1]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); rowsEls[i - 1]?.focus(); }
    else if (e.key === "Enter" && onRowClick) { e.preventDefault(); onRowClick(row); }
  };

  const hide = (c: Column<T>) => (c.hideOnMobile ? "hidden md:table-cell" : "");
  const cell = "px-[var(--cell-px)] py-[var(--cell-py)]";

  if (!loading && rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[12px] border border-dashed border-line-strong bg-panel px-6 py-14 text-center">
        <EmptyIcon className="mb-3 h-6 w-6 text-fg-3" aria-hidden />
        <h3 className="text-sm font-semibold text-fg">{emptyTitle}</h3>
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-fg-3">{emptyDescription}</p>
        {emptyAction && <div className="mt-4">{emptyAction}</div>}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-panel">
      <div className="overflow-x-auto">
        <table className={clsx("w-full border-collapse text-left", fixed && "table-fixed")} aria-label={label} aria-busy={loading || undefined}>
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              {columns.map((col) => {
                const active = sort?.key === col.key;
                const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : col.sortable ? "none" : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={clsx(
                      "border-b border-line text-[12px] font-medium text-fg-3",
                      cell,
                      col.align === "right" && "text-right",
                      hide(col),
                      col.className,
                    )}
                    style={col.width ? { width: col.width, minWidth: col.minWidth } : undefined}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={clsx("focus-ring -mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-fg", active && "text-fg", col.align === "right" && "flex-row-reverse")}
                      >
                        {col.header}
                        {active && sort!.dir === "asc" && <ChevronUp className="h-3 w-3" aria-hidden />}
                        {active && sort!.dir === "desc" && <ChevronDown className="h-3 w-3" aria-hidden />}
                      </button>
                    ) : col.headerHidden ? (
                      <span className="sr-only">{col.header}</span>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
              {rowActions?.length ? <th className="w-10 border-b border-line" aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {loading && rows.length === 0
              ? Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    {columns.map((c) => (
                      <td key={c.key} className={clsx(cell, hide(c))} style={{ height: "var(--row-h)" }}>
                        <span className="block h-3 w-2/3 animate-pulse rounded bg-raised" />
                      </td>
                    ))}
                  </tr>
                ))
              : visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                    className={clsx(
                      "group border-b border-line text-[13px] text-fg-2 last:border-0",
                      onRowClick && "cursor-pointer outline-none hover:bg-raised focus-visible:bg-raised focus-visible:shadow-[inset_2px_0_0_var(--color-accent)]",
                    )}
                    style={{ height: "var(--row-h)" }}
                  >
                    {columns.map((col) => (
                      <td key={col.key} className={clsx(cell, col.align === "right" && "text-right", hide(col), col.className)}>
                        {col.render(row)}
                      </td>
                    ))}
                    {rowActions?.length ? (
                      <td className="px-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          {rowActions.map((a) => (
                            <button
                              key={a.label}
                              type="button"
                              onClick={() => a.onClick(row)}
                              aria-label={a.label}
                              title={a.label}
                              className={clsx(
                                "focus-ring rounded-md p-1.5 text-fg-3 transition-colors",
                                a.variant === "danger" ? "hover:bg-bad-soft hover:text-bad" : "hover:bg-hover hover:text-fg",
                              )}
                            >
                              <a.icon className="h-3.5 w-3.5" />
                            </button>
                          ))}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {paged && sorted.length > pageSize && (
        <div className="flex items-center justify-between border-t border-line px-[var(--cell-px)] py-2 text-[12px] text-fg-3">
          <span className="num">
            {current * pageSize + 1}–{Math.min((current + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(0, current - 1))}
              disabled={current === 0}
              aria-label="Previous page"
              className="focus-ring flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-fg disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages - 1, current + 1))}
              disabled={current >= totalPages - 1}
              aria-label="Next page"
              className="focus-ring flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-fg disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
