import React, { useId, useState } from 'react'

/**
 * Small, dependency-free charts for the admin panel (design-system/MASTER.md "Charts").
 *
 * Rules they follow: series are told apart by legend labels and order, never by colour alone;
 * every value is available on hover or keyboard focus; each chart carries a screen-reader table or
 * summary; colours come from the --color-chart-* tokens (3:1 against white).
 */

export interface Series {
  key: string
  label: string
  /** A CSS colour, normally one of the chart tokens, e.g. var(--color-chart-completed). */
  color: string
}

export const STATUS_SERIES: Series[] = [
  { key: 'completed', label: 'Completed', color: 'var(--color-chart-completed)' },
  { key: 'exceptions', label: 'Exception', color: 'var(--color-chart-exception)' },
  { key: 'missed', label: 'Missed', color: 'var(--color-chart-missed)' },
  { key: 'open', label: 'Open', color: 'var(--color-chart-open)' }
]

const fmt = (n: number) => n.toLocaleString('en-IN')

/** Legend: a swatch and label per series, with the value when given. */
export const ChartLegend: React.FC<{ items: (Series & { value?: number | string })[]; className?: string }> = ({ items, className = '' }) => (
  <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-secondary ${className}`}>
    {items.map((s) => (
      <li key={s.key} className="inline-flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
        <span>{s.label}</span>
        {s.value !== undefined && <span className="font-semibold text-ink tabular-nums">{typeof s.value === 'number' ? fmt(s.value) : s.value}</span>}
      </li>
    ))}
  </ul>
)

/** A round-number top for the value axis with four equal steps, so gridlines read 0 / 10 / 20 / 30 / 40. */
function niceMax(max: number) {
  if (max <= 4) return 4
  const raw = max / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw && Number.isInteger(s)) ?? 10 * magnitude
  return step * 4
}

export interface StackedBarDatum {
  /** Short axis label, e.g. "Mon". */
  label: string
  /** Full label for the tooltip, e.g. "Mon 06/10/2026". */
  fullLabel?: string
  values: Record<string, number>
  /** Marks the bar (e.g. the selected day) with a bolder axis label. */
  highlight?: boolean
}

/**
 * Vertical stacked columns, e.g. checks per day split by status. Hover or focus a column for its
 * numbers. Responsive: columns share the width, labels stay legible.
 */
export const StackedBarChart: React.FC<{
  data: StackedBarDatum[]
  series: Series[]
  height?: number
  /** One sentence describing the chart for screen readers. */
  summary: string
  onSelect?: (index: number) => void
}> = ({ data, series, height = 180, summary, onSelect }) => {
  const [active, setActive] = useState<number | null>(null)
  const totals = data.map((d) => series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0))
  const top = niceMax(Math.max(1, ...totals))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f))
  const tableId = useId()

  return (
    <div className="w-full" role="group" aria-label={summary} aria-describedby={tableId}>
      <div className="relative flex gap-2" style={{ height }}>
        {/* Value axis */}
        <div className="flex flex-col justify-between text-[10.5px] text-ink-muted tabular-nums text-right w-7 shrink-0 -my-1.5" aria-hidden>
          {[...ticks].reverse().map((t) => (
            <span key={t}>{fmt(t)}</span>
          ))}
        </div>
        <div className="relative flex-1 min-w-0">
          {/* Gridlines */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none" aria-hidden>
            {ticks.map((t) => (
              <div key={t} className="border-t border-[var(--color-chart-grid)]" />
            ))}
          </div>
          {/* Columns */}
          <div className="absolute inset-0 flex items-end gap-[6%] px-[3%]">
            {data.map((d, i) => {
              const total = totals[i]
              const isActive = active === i
              return (
                <button
                  key={d.label + i}
                  type="button"
                  className={`relative flex-1 h-full flex flex-col justify-end items-stretch rounded-t-[4px] outline-offset-2 ${onSelect ? 'cursor-pointer' : 'cursor-default'}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  onClick={onSelect ? () => onSelect(i) : undefined}
                  aria-label={`${d.fullLabel ?? d.label}: ${series.map((s) => `${s.label} ${fmt(d.values[s.key] ?? 0)}`).join(', ')}`}
                >
                  <span
                    className={`flex flex-col-reverse w-full max-w-[44px] mx-auto overflow-hidden rounded-t-[4px] transition-opacity ${active !== null && !isActive ? 'opacity-55' : ''}`}
                    style={{ height: `${(total / top) * 100}%` }}
                    aria-hidden
                  >
                    {series.map((s) => {
                      const v = d.values[s.key] ?? 0
                      return v > 0 ? <span key={s.key} style={{ height: `${(v / Math.max(total, 1)) * 100}%`, backgroundColor: s.color }} className="w-full block border-t border-white/70 first:border-t-0" /> : null
                    })}
                  </span>
                  {isActive && (
                    <span className="absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2.5 py-2 text-left text-[11.5px] text-white shadow-[var(--shadow-pop)]" aria-hidden>
                      <span className="block font-semibold mb-1">{d.fullLabel ?? d.label}</span>
                      {series.map((s) => (
                        <span key={s.key} className="flex items-center gap-1.5 leading-relaxed">
                          <span className="w-2 h-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                          <span className="opacity-80">{s.label}</span>
                          <span className="ml-auto pl-3 font-semibold tabular-nums">{fmt(d.values[s.key] ?? 0)}</span>
                        </span>
                      ))}
                      <span className="mt-1 pt-1 border-t border-white/15 flex justify-between gap-3">
                        <span className="opacity-80">Total</span>
                        <span className="font-semibold tabular-nums">{fmt(total)}</span>
                      </span>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {/* Category axis */}
      <div className="flex gap-2 mt-1.5" aria-hidden>
        <div className="w-7 shrink-0" />
        <div className="flex-1 flex gap-[6%] px-[3%]">
          {data.map((d, i) => (
            <span key={d.label + i} className={`flex-1 text-center text-[11px] leading-tight break-words ${d.highlight ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
              {d.label}
            </span>
          ))}
        </div>
      </div>
      <table id={tableId} className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.label + i}>
              <th scope="row">{d.fullLabel ?? d.label}</th>
              {series.map((s) => (
                <td key={s.key}>{d.values[s.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One horizontal bar split into segments (e.g. a department's checks by status). */
export const SegmentBar: React.FC<{ values: Record<string, number>; series: Series[]; height?: number; className?: string }> = ({
  values,
  series,
  height = 8,
  className = ''
}) => {
  const total = series.reduce((n, s) => n + (values[s.key] ?? 0), 0)
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-subtle ${className}`} style={{ height }} aria-hidden>
      {total > 0 &&
        series.map((s) => {
          const v = values[s.key] ?? 0
          return v > 0 ? <span key={s.key} className="h-full border-l border-white/80 first:border-l-0" style={{ width: `${(v / total) * 100}%`, backgroundColor: s.color }} title={`${s.label}: ${fmt(v)}`} /> : null
        })}
    </div>
  )
}

export interface BarListRow {
  key: string
  label: string
  detail?: string | null
  values: Record<string, number>
  /** Right-hand figure, e.g. "92%". */
  value: React.ReactNode
  valueTone?: string
}

/**
 * A ranked list with one segmented bar per row: departments or workers with their checks by
 * status. Reads as a table for screen readers.
 */
export const BarList: React.FC<{ rows: BarListRow[]; series: Series[]; valueLabel: string; labelHeader: string; emptyText?: string }> = ({
  rows,
  series,
  valueLabel,
  labelHeader,
  emptyText = 'No data'
}) =>
  rows.length === 0 ? (
    <div className="py-6 text-center text-[12px] text-ink-muted">{emptyText}</div>
  ) : (
    <table className="w-full text-[12.5px]">
      <thead className="sr-only">
        <tr>
          <th scope="col">{labelHeader}</th>
          <th scope="col">Checks by status</th>
          <th scope="col">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const total = series.reduce((n, s) => n + (r.values[s.key] ?? 0), 0)
          return (
            <tr key={r.key} className="align-middle">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium text-ink w-[38%] max-w-0">
                <span className="block truncate" title={r.label}>
                  {r.label}
                </span>
                {r.detail && <span className="block text-[11px] font-normal text-ink-muted truncate">{r.detail}</span>}
              </th>
              <td className="py-1.5 pr-3">
                <SegmentBar values={r.values} series={series} />
                <span className="sr-only">{series.map((s) => `${s.label} ${r.values[s.key] ?? 0}`).join(', ')}</span>
                <span className="block mt-1 text-[10.5px] text-ink-muted tabular-nums" aria-hidden>
                  {fmt(total)} {total === 1 ? 'check' : 'checks'}
                </span>
              </td>
              <td className={`py-1.5 text-right font-semibold tabular-nums whitespace-nowrap w-14 ${r.valueTone ?? 'text-ink'}`}>{r.value}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

/** A ring chart for a part-to-whole split of up to five parts, with the total (or a label) in the middle. */
export const DonutChart: React.FC<{
  segments: (Series & { value: number })[]
  centerValue: React.ReactNode
  centerLabel: string
  size?: number
  summary: string
}> = ({ segments, centerValue, centerLabel, size = 148, summary }) => {
  const total = segments.reduce((n, s) => n + s.value, 0)
  const stroke = 16
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={summary}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-subtle)" strokeWidth={stroke} />
        {total > 0 &&
          segments.map((s) => {
            if (s.value <= 0) return null
            const len = (s.value / total) * c
            // A 1.5px gap between parts keeps neighbouring colours apart.
            const gap = segments.filter((x) => x.value > 0).length > 1 ? 1.5 : 0
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}`}
                strokeDashoffset={-offset}
              >
                <title>{`${s.label}: ${fmt(s.value)}`}</title>
              </circle>
            )
            offset += len
            return el
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="text-[22px] font-semibold text-ink leading-none tabular-nums">{centerValue}</span>
        <span className="mt-1 text-[11px] text-ink-muted">{centerLabel}</span>
      </div>
    </div>
  )
}

/** A tiny trend line for a KPI card. Decorative: the card shows the number itself. */
export const Sparkline: React.FC<{ values: number[]; color?: string; width?: number; height?: number }> = ({
  values,
  color = 'var(--color-chart-primary)',
  width = 88,
  height = 28
}) => {
  const gradient = useId()
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const points = values.map((v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as const)
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradient})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2.25" fill={color} />
    </svg>
  )
}

const PROGRESS_TONE = {
  accent: 'bg-accent',
  success: 'bg-[var(--color-chart-completed)]',
  missed: 'bg-[var(--color-chart-missed)]',
  exception: 'bg-[var(--color-chart-exception)]',
  neutral: 'bg-[var(--color-chart-open)]'
}

/** A thin progress bar with a proper progressbar role. */
export const ProgressBar: React.FC<{ value: number; label: string; tone?: keyof typeof PROGRESS_TONE; className?: string }> = ({
  value,
  label,
  tone = 'accent',
  className = ''
}) => {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      className={`h-1.5 ${/(^|\s)(min-|max-)?w-/.test(className) ? '' : 'w-full'} rounded-full bg-subtle overflow-hidden ${className}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className={`h-full rounded-full ${PROGRESS_TONE[tone]} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}
