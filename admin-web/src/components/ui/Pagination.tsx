import React, { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Client-side paging for lists the server sends whole (design-system/MASTER.md "Tables"). The page
 * resets to 1 whenever `resetKey` changes (e.g. the filters), and never points past the last page.
 * Exports and totals keep using the full list; only the rows on screen are paged.
 */
export function usePagination<T>(rows: T[], initialPageSize = 25, resetKey: unknown = null) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  useEffect(() => {
    setPage(1)
  }, [resetKey])
  const current = Math.min(page, pages)
  const visible = useMemo(() => rows.slice((current - 1) * pageSize, current * pageSize), [rows, current, pageSize])
  const changePageSize = (size: number) => {
    setPageSize(size)
    setPage(1)
  }
  return { page: current, pages, setPage, visible, total: rows.length, pageSize, setPageSize: changePageSize }
}

/** "1–25 of 140" with previous / next and page numbers. Hidden when everything fits on one page. */
export const Pagination: React.FC<{
  page: number
  pages: number
  total: number
  pageSize: number
  onPage: (page: number) => void
  noun?: string
  /** Offer a rows-per-page choice, e.g. [25, 50, 100]. */
  pageSizeOptions?: number[]
  onPageSize?: (size: number) => void
}> = ({ page, pages, total, pageSize, onPage, noun = 'rows', pageSizeOptions, onPageSize }) => {
  if (pages <= 1 && !(pageSizeOptions && onPageSize && total > Math.min(...pageSizeOptions))) return null
  const first = (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  // Up to 5 page buttons around the current page.
  const start = Math.max(1, Math.min(page - 2, pages - 4))
  const numbers = Array.from({ length: Math.min(5, pages) }, (_, i) => start + i)
  const btn = 'h-8 min-w-8 px-2 inline-flex items-center justify-center rounded-md text-[12.5px] font-medium tabular-nums transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-t border-line" aria-label="Pagination">
      <span className="flex items-center gap-3 text-[12px] text-ink-muted tabular-nums">
        <span>
          {first.toLocaleString('en-IN')}–{last.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} {noun}
        </span>
        {pageSizeOptions && onPageSize && (
          <label className="inline-flex items-center gap-1.5">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-7 px-1.5 rounded-md border border-line-strong bg-white text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/25"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </span>
      <div className="flex items-center gap-1">
        <button type="button" className={`${btn} text-ink-secondary hover:bg-subtle`} onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous page">
          <ChevronLeft className="w-4 h-4" />
        </button>
        {numbers.map((n) => (
          <button
            key={n}
            type="button"
            className={`${btn} ${n === page ? 'bg-accent-soft text-accent-strong ring-1 ring-accent-line' : 'text-ink-secondary hover:bg-subtle'}`}
            onClick={() => onPage(n)}
            aria-current={n === page ? 'page' : undefined}
            aria-label={`Page ${n}`}
          >
            {n}
          </button>
        ))}
        <button type="button" className={`${btn} text-ink-secondary hover:bg-subtle`} onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Next page">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </nav>
  )
}
