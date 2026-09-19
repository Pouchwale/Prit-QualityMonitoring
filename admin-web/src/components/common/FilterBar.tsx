import React, { useId, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Activity, Department, Machine, Shift, User } from '../../types'
import { useApi } from '../../lib/useApi'
import { addDaysKey, dateKey } from '../../lib/format'
import { Button } from './Button'
import { inputClass } from './Form'
import { DateInput } from './DateTimeInputs'

/** Filters shared by the monitoring pages. Empty string means "all". */
export interface MonitoringFilters {
  from: string
  to: string
  shiftId: string
  machineId: string
  workerId: string
  activityId: string
  departmentId: string
  status: string
  /** Whole Item Code / Job No. (case-insensitive); only on pages that show these fields. */
  itemCode?: string
  jobNo?: string
}

export type FilterField = 'shift' | 'machine' | 'worker' | 'activity' | 'department' | 'status' | 'itemCode' | 'jobNo'

interface FilterBarProps {
  value: MonitoringFilters
  onChange: (value: MonitoringFilters) => void
  onReset?: () => void
  /** Which select filters to show. */
  fields: FilterField[]
  /** Show the date range inputs and presets. Off when the page has its own date filter. */
  showDates?: boolean
  statusOptions?: { value: string; label: string }[]
  /** Label of the status select, e.g. "Result" on the Reports page. */
  statusLabel?: string
  /** Extra controls rendered at the end of the bar. */
  children?: React.ReactNode
}

const selectClass = `${inputClass} px-2 sm:w-auto sm:min-w-[130px] sm:max-w-[190px]`

/** Date range plus master-data filters. Loads its own option lists. */
export const FilterBar: React.FC<FilterBarProps> = ({ value, onChange, onReset, fields, statusOptions = [], statusLabel = 'Status', showDates = true, children }) => {
  const has = (f: FilterField) => fields.includes(f)
  const shifts = useApi<Shift[]>(has('shift') ? '/api/shifts' : null)
  const machines = useApi<Machine[]>(has('machine') ? '/api/machines' : null)
  const workers = useApi<User[]>(has('worker') ? '/api/users' : null, { role: 'WORKER' })
  const activities = useApi<Activity[]>(has('activity') ? '/api/activities' : null)
  const departments = useApi<Department[]>(has('department') ? '/api/departments' : null)
  // Item Codes and Job Nos. recorded in the period, offered as suggestions (typing any value works too).
  const jobValues = useApi<{ itemCodes: string[]; jobNos: string[] }>(
    has('itemCode') || has('jobNo') ? '/api/reports/filter-values' : null,
    { from: value.from, to: value.to }
  )

  const set = (patch: Partial<MonitoringFilters>) => onChange({ ...value, ...patch })

  const setFrom = (from: string) => {
    if (!from) return
    set({ from, to: value.to < from ? from : value.to })
  }
  const setTo = (to: string) => {
    if (!to) return
    set({ to, from: value.from > to ? to : value.from })
  }

  const today = dateKey()
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: '7 days', from: addDaysKey(today, -6), to: today },
    { label: '30 days', from: addDaysKey(today, -29), to: today }
  ]

  return (
    <div className="bg-white border border-line rounded-md p-3 shadow-2xs no-print">
      {/* Phones: two columns of full-width controls. From sm up: one wrapping row, as before. */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 text-xs">
        {showDates && (
          <>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">From</span>
              <DateInput value={value.from} max={value.to} onChange={(e) => setFrom(e.target.value)} className="sm:w-[160px] lg:w-[132px]" />
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] font-semibold text-ink-secondary mb-1">To</span>
              <DateInput value={value.to} min={value.from} onChange={(e) => setTo(e.target.value)} className="sm:w-[160px] lg:w-[132px]" />
            </label>
            <div className="col-span-2 grid grid-cols-3 sm:flex items-center rounded border border-line-strong overflow-hidden h-[40px] lg:h-8">
              {presets.map((p) => {
                const active = value.from === p.from && value.to === p.to
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => set({ from: p.from, to: p.to })}
                    className={`px-2.5 h-full text-[12px] lg:text-[11px] font-medium whitespace-nowrap border-r border-line last:border-r-0 transition-colors ${
                      active ? 'bg-accent text-white' : 'bg-white text-ink-secondary hover:bg-slate-50'
                    }`}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {has('itemCode') && (
          <FilterText
            label="Item Code"
            value={value.itemCode ?? ''}
            suggestions={jobValues.data?.itemCodes ?? []}
            placeholder="All item codes"
            onCommit={(itemCode) => set({ itemCode })}
          />
        )}
        {has('jobNo') && (
          <FilterText
            label="Job No."
            value={value.jobNo ?? ''}
            suggestions={jobValues.data?.jobNos ?? []}
            placeholder="All job numbers"
            onCommit={(jobNo) => set({ jobNo })}
          />
        )}

        {has('shift') && (
          <FilterSelect label="Shift" value={value.shiftId} onChange={(shiftId) => set({ shiftId })} allLabel="All shifts">
            {(shifts.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </FilterSelect>
        )}
        {has('machine') && (
          <FilterSelect label="Machine" value={value.machineId} onChange={(machineId) => set({ machineId })} allLabel="All machines">
            {(machines.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.code})
              </option>
            ))}
          </FilterSelect>
        )}
        {has('worker') && (
          <FilterSelect label="Worker" value={value.workerId} onChange={(workerId) => set({ workerId })} allLabel="All workers">
            {(workers.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.employeeId})
              </option>
            ))}
          </FilterSelect>
        )}
        {has('activity') && (
          <FilterSelect label="Check type" value={value.activityId} onChange={(activityId) => set({ activityId })} allLabel="All check types">
            {(activities.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </FilterSelect>
        )}
        {has('department') && (
          <FilterSelect label="Department" value={value.departmentId} onChange={(departmentId) => set({ departmentId })} allLabel="All departments">
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </FilterSelect>
        )}
        {has('status') && (
          <FilterSelect label={statusLabel} value={value.status} onChange={(status) => set({ status })} allLabel={`All ${statusLabel === 'Status' ? 'statuses' : `${statusLabel.toLowerCase()}s`}`}>
            {statusOptions.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </FilterSelect>
        )}

        {onReset && (
          <Button size="field" variant="ghost" onClick={onReset} icon={<RotateCcw className="w-3 h-3" />}>
            Reset
          </Button>
        )}
        {children && <div className="col-span-2 sm:ml-auto flex flex-wrap items-end gap-2">{children}</div>}
      </div>
    </div>
  )
}

const FilterSelect: React.FC<{
  label: string
  value: string
  allLabel: string
  onChange: (value: string) => void
  children: React.ReactNode
}> = ({ label, value, allLabel, onChange, children }) => (
  <label className="min-w-0">
    <span className="block text-[11px] font-semibold text-ink-secondary mb-1">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      <option value="">{allLabel}</option>
      {children}
    </select>
  </label>
)

/**
 * A typed filter with suggestions from the recorded values. It applies when the user picks a
 * suggestion, presses Enter or leaves the field, not on every keystroke.
 */
const FilterText: React.FC<{
  label: string
  value: string
  suggestions: string[]
  placeholder: string
  onCommit: (value: string) => void
}> = ({ label, value, suggestions, placeholder, onCommit }) => {
  const [text, setText] = useState(value)
  const [shown, setShown] = useState(value)
  // A new value from outside (e.g. Reset) replaces what is typed.
  if (shown !== value) {
    setShown(value)
    setText(value)
  }
  const listId = useId()
  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed !== value) onCommit(trimmed)
  }
  return (
    <label className="min-w-0">
      <span className="block text-[11px] font-semibold text-ink-secondary mb-1">{label}</span>
      <span className="relative block">
        <input
          type="search"
          value={text}
          list={listId}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => {
            setText(e.target.value)
            // Picked from the suggestion list, or cleared with the search box's ×: apply at once.
            const native = e.nativeEvent as InputEvent
            if (!e.target.value || native.inputType === 'insertReplacementText' || !native.inputType) commit(e.target.value)
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(text)
            }
          }}
          className={`${inputClass} sm:w-[150px] lg:w-[130px] ${value ? 'border-accent' : ''}`}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </span>
    </label>
  )
}
