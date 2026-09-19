import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  FileSpreadsheet,
  FileText,
  FileUp,
  ImageIcon,
  Info,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type { CalendarIssue, CalendarYearDetail, CalendarYearItem, CalendarYearSummary, ClosureType } from '../../../types'
import { api, download, errorText, fetchBlob, upload } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { useCanManage } from '../../../lib/auth'
import { CLOSURE_TYPES, WEEKDAY_NAMES } from '../../../lib/closureTypes'
import { formatDateKey, formatDateTime } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { DataState } from '../../../components/common/DataState'
import { Field, FormError, Select, TextInput } from '../../../components/common/Form'
import { Modal } from '../../../components/common/Modal'
import { useToast } from '../../../components/common/Toast'
import { DateInput } from '../../../components/common/DateTimeInputs'

const toDate = (iso: string) => new Date(`${iso}T00:00:00`)
const fullDate = (iso: string) => formatDateKey(iso)
const weekdayName = (iso: string) => WEEKDAY_NAMES[toDate(iso).getDay()]

const METHOD_LABEL: Record<string, string> = {
  EXCEL: 'Excel / CSV',
  PDF_TEXT: 'PDF text',
  OCR: 'Offline OCR',
  MANUAL: 'Entered by hand'
}

const ITEM_TYPES: ClosureType[] = ['HOLIDAY', 'WORKING', 'SHUTDOWN', 'CLOSED']

function yearStatus(year: { status: string; pendingChanges: boolean }) {
  if (year.status === 'APPROVED' && year.pendingChanges) return { label: 'Changes awaiting approval', className: 'bg-exception-bg text-exception border-exception-line' }
  if (year.status === 'APPROVED') return { label: 'Approved · in use', className: 'bg-success-bg text-success border-success-line' }
  return { label: 'Draft · not in use', className: 'bg-slate-50 text-ink-secondary border-line' }
}

/** Annual company calendars: create a year, import the company document, review every date, approve. */
export const AnnualCalendarsTab: React.FC<{ yearId: string | null; onOpenYear: (id: string | null) => void }> = ({ yearId, onOpenYear }) => {
  return yearId ? <YearReview yearId={yearId} onBack={() => onOpenYear(null)} /> : <YearList onOpenYear={onOpenYear} />
}

// ---------------------------------------------------------------- list

const YearList: React.FC<{ onOpenYear: (id: string) => void }> = ({ onOpenYear }) => {
  const canEdit = useCanManage('calendar')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<{ firstYear: number; years: CalendarYearSummary[] }>('/api/calendar-years')
  const [creating, setCreating] = useState(false)
  const [newYear, setNewYear] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const years = data?.years ?? []
  const choices = useMemo(() => {
    if (!data) return []
    const existing = new Set(data.years.map((y) => y.year))
    const last = new Date().getFullYear() + 10
    return Array.from({ length: last - data.firstYear + 1 }, (_, i) => data.firstYear + i).filter((y) => !existing.has(y))
  }, [data])

  const openCreate = () => {
    setNewYear(choices[0] ?? '')
    setFormError(null)
    setCreating(true)
  }

  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!newYear) return
    setSaving(true)
    setFormError(null)
    try {
      const detail = await api.post<CalendarYearDetail>('/api/calendar-years', { year: newYear })
      notify('success', `${newYear} calendar created`, 'Import the company document or add the dates by hand, then approve.')
      setCreating(false)
      reload()
      onOpenYear(detail.year.id)
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink">Annual calendars</h2>
          <p className="text-xs text-ink-muted">
            One company calendar per year from {data?.firstYear ?? 2027}. Import the company document, check every date, then approve. Dates only affect checks
            and alerts after approval.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" variant="primary" onClick={openCreate} disabled={!data || choices.length === 0} icon={<Plus className="w-3.5 h-3.5" />}>
            New calendar year
          </Button>
        )}
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={data !== null && years.length === 0} emptyText="No annual calendars yet. Create the next year's calendar when the company holiday list is available.">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {years.map((year) => {
            const status = yearStatus(year)
            return (
              <button
                key={year.id}
                type="button"
                onClick={() => onOpenYear(year.id)}
                className="text-left bg-white border border-line rounded-lg shadow-2xs p-4 hover:border-line-strong hover:shadow-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`${year.year} calendar, ${status.label}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-2xl font-bold text-ink tabular-nums">{year.year}</div>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-medium ${status.className}`}>{status.label}</span>
                </div>
                <div className="mt-2 text-xs text-ink-secondary">
                  {year.holidays} holiday{year.holidays === 1 ? '' : 's'} · {year.workingDays} adjustment working day{year.workingDays === 1 ? '' : 's'}
                </div>
                <div className="mt-1 text-[11px] text-ink-muted truncate">
                  {year.sourceFileName ? `${year.sourceFileName} · ${METHOD_LABEL[year.extractionMethod ?? ''] ?? ''}` : 'No document imported'}
                </div>
                <div className={`mt-2 text-[11px] font-medium ${year.openIssues ? 'text-exception' : 'text-success'}`}>
                  {year.openIssues
                    ? `${year.openIssues} item${year.openIssues === 1 ? '' : 's'} to check`
                    : year.holidays + year.workingDays === 0
                      ? 'No dates yet'
                      : year.approvedAt && !year.pendingChanges
                        ? `Approved ${formatDateTime(year.approvedAt)}`
                        : 'Ready to approve'}
                </div>
              </button>
            )
          })}
        </div>
      </DataState>

      {creating && (
        <Modal
          isOpen
          onClose={() => setCreating(false)}
          title="New calendar year"
          subtitle="Weekly rules apply at once; holidays apply after approval"
          footer={
            <>
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" form="new-year-form" variant="primary" loading={saving} disabled={!newYear}>
                Create
              </Button>
            </>
          }
        >
          <form id="new-year-form" onSubmit={create} className="space-y-4">
            <FormError message={formError} />
            <Field label="Year" required>
              <Select value={newYear} onChange={(e) => setNewYear(Number(e.target.value))}>
                {choices.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </Select>
            </Field>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- review

type ItemForm = { id: string | null; type: ClosureType; date: string; name: string; forHolidayDate: string }

const YearReview: React.FC<{ yearId: string; onBack: () => void }> = ({ yearId, onBack }) => {
  const canEdit = useCanManage('calendar')
  const notify = useToast()
  const { data, error, loading, reload, setData } = useApi<CalendarYearDetail>(`/api/calendar-years/${yearId}`)
  const [importing, setImporting] = useState(false)
  const [replaceFile, setReplaceFile] = useState<File | null>(null)
  const [editing, setEditing] = useState<ItemForm | null>(null)
  const [deleting, setDeleting] = useState<CalendarYearItem | null>(null)
  const [approving, setApproving] = useState(false)
  const [deletingYear, setDeletingYear] = useState(false)
  const [docVersion, setDocVersion] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  const issuesByItem = useMemo(() => {
    const map = new Map<string, CalendarIssue[]>()
    for (const issue of data?.issues ?? []) if (issue.itemId) map.set(issue.itemId, [...(map.get(issue.itemId) ?? []), issue])
    return map
  }, [data])

  if (!data) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={onBack} icon={<ArrowLeft className="w-3.5 h-3.5" />}>
          Annual calendars
        </Button>
        <DataState loading={loading} error={error} onRetry={reload}>
          {null}
        </DataState>
      </div>
    )
  }

  const { year, items, issues } = data
  const status = yearStatus(year)
  const holidays = items.filter((i) => i.type !== 'WORKING')
  const workingDays = items.filter((i) => i.type === 'WORKING')
  const blocking = issues.filter((i) => i.severity === 'BLOCKING')
  const checks = issues.filter((i) => i.severity === 'CHECK')
  const generalIssues = issues.filter((i) => !i.itemId && i.severity !== 'INFO')
  const sorted = [...items].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.position - b.position)

  const runImport = async (file: File, replace: boolean) => {
    setImporting(true)
    try {
      const form = new FormData()
      form.append('document', file)
      const result = await upload<CalendarYearDetail & { summary: { method: string; datesFound: number; uncertain: number } }>(
        `/api/calendar-years/${yearId}/import`,
        form,
        { replace }
      )
      const { summary, ...detail } = result
      setData(detail)
      setDocVersion((v) => v + 1)
      notify(
        summary.datesFound ? 'success' : 'warning',
        summary.datesFound ? `${summary.datesFound} dates read from ${file.name}` : 'No dates could be read',
        summary.datesFound
          ? `${summary.uncertain ? `${summary.uncertain} need checking. ` : ''}Check every date against the document before approving.`
          : 'Add the dates by hand, or upload a clearer copy of the calendar.'
      )
    } catch (err) {
      notify('error', 'Could not import the document', errorText(err))
    } finally {
      setImporting(false)
    }
  }

  const chooseFile = (file: File | undefined) => {
    if (!file) return
    if (items.length) setReplaceFile(file)
    else runImport(file, false)
  }

  const act = async (fn: () => Promise<CalendarYearDetail>, success?: string) => {
    try {
      setData(await fn())
      if (success) notify('success', success)
    } catch (err) {
      notify('error', 'Could not save', errorText(err))
    }
  }

  const approve = async () => {
    const result = await api.post<CalendarYearDetail & { removedChecks: number }>(`/api/calendar-years/${yearId}/approve`)
    const { removedChecks, ...detail } = result
    setData(detail)
    notify(
      'success',
      `${year.year} calendar approved`,
      `${holidays.length} holidays and ${workingDays.length} adjustment working days now decide checks and alerts.${removedChecks ? ` ${removedChecks} upcoming check${removedChecks === 1 ? ' was' : 's were'} removed from closed days.` : ''}`
    )
  }

  const removeYear = async () => {
    try {
      await api.del(`/api/calendar-years/${yearId}`)
      notify('success', `${year.year} calendar deleted`)
      onBack()
    } catch (err) {
      notify('error', 'Could not delete the calendar', errorText(err))
    }
  }

  const approveHint = !canEdit
    ? null
    : blocking.length || checks.length
      ? `${blocking.length + checks.length} item${blocking.length + checks.length === 1 ? '' : 's'} to fix or check first`
      : items.length === 0
        ? 'Add the dates first'
        : year.status === 'APPROVED' && !year.pendingChanges
          ? 'Approved and in use'
          : null

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Button size="sm" variant="ghost" onClick={onBack} icon={<ArrowLeft className="w-3.5 h-3.5" />}>
            <span className="hidden sm:inline">Annual calendars</span>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-ink tabular-nums">{year.year} calendar</h2>
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-medium ${status.className}`}>{status.label}</span>
            </div>
            <p className="text-[11px] text-ink-muted">
              {holidays.length} holiday{holidays.length === 1 ? '' : 's'} · {workingDays.length} adjustment working day{workingDays.length === 1 ? '' : 's'}
              {year.approvedAt ? ` · last approved ${formatDateTime(year.approvedAt)}` : ''}
            </p>
          </div>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.csv,.pdf,.png,.jpg,.jpeg,.webp,.bmp"
              className="hidden"
              aria-label="Calendar document"
              onChange={(e) => {
                chooseFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            {year.status === 'DRAFT' && (
              <Button size="sm" variant="ghost" onClick={() => setDeletingYear(true)} icon={<Trash2 className="w-3.5 h-3.5" />} className="text-failed hover:text-failed">
                Delete draft
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} loading={importing} icon={<FileUp className="w-3.5 h-3.5" />}>
              {importing ? 'Reading document…' : year.hasDocument ? 'Import new document' : 'Import document'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing({ id: null, type: 'HOLIDAY', date: `${year.year}-01-01`, name: '', forHolidayDate: '' })}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              Add date
            </Button>
            {(year.status !== 'APPROVED' || year.pendingChanges) && (
              <Button size="sm" variant="primary" onClick={() => setApproving(true)} disabled={!!approveHint} icon={<ShieldCheck className="w-3.5 h-3.5" />} title={approveHint ?? undefined}>
                {year.status === 'APPROVED' ? 'Approve changes' : 'Approve calendar'}
              </Button>
            )}
          </div>
        )}
      </div>

      {importing && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-blue-200 bg-blue-50 text-xs text-blue-800" role="status">
          <Info className="w-4 h-4 shrink-0" />
          Reading the document on the server. Photos and scans are read with offline OCR, which can take up to a minute.
        </div>
      )}

      <ReviewSummary year={data} blocking={blocking.length} checks={checks.length} approveHint={approveHint} general={generalIssues} />

      {/* Side by side on very wide screens; otherwise the document sits above the dates. */}
      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4 items-start">
        <DocumentPreview yearId={yearId} year={data.year} version={docVersion} />

        <section className="bg-white border border-line rounded-lg shadow-2xs overflow-hidden" aria-label="Calendar dates">
          <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink">Dates ({items.length})</h3>
            <span className="text-[11px] text-ink-muted hidden sm:inline">Check each row against the document</span>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {year.hasDocument ? 'No dates were read from the document. Add them by hand.' : 'Import the company calendar document, or add the dates by hand.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="stack-sm w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Date</th>
                    <th className="py-2 px-3 font-semibold">Type</th>
                    <th className="py-2 px-3 font-semibold">Holiday / note · read from document</th>
                    <th className="py-2 px-3 font-semibold">Review</th>
                    {canEdit && <th className="py-2 px-3 font-semibold text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sorted.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      holidays={holidays}
                      issues={issuesByItem.get(item.id) ?? []}
                      canEdit={canEdit}
                      onEdit={() =>
                        setEditing({ id: item.id, type: item.type, date: item.date ?? '', name: item.name ?? '', forHolidayDate: item.forHolidayDate ?? '' })
                      }
                      onConfirm={() => act(() => api.post<CalendarYearDetail>(`/api/calendar-years/${yearId}/items/${item.id}/confirm`), 'Row checked')}
                      onDelete={() => setDeleting(item)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {editing && (
        <ItemModal
          form={editing}
          year={year.year}
          holidays={holidays}
          sourceText={editing.id ? items.find((i) => i.id === editing.id)?.sourceText ?? null : null}
          onClose={() => setEditing(null)}
          onSave={async (form) => {
            const body = { type: form.type, date: form.date, name: form.name.trim() || null, forHolidayDate: form.type === 'WORKING' ? form.forHolidayDate || null : null }
            const detail = form.id
              ? await api.put<CalendarYearDetail>(`/api/calendar-years/${yearId}/items/${form.id}`, body)
              : await api.post<CalendarYearDetail>(`/api/calendar-years/${yearId}/items`, body)
            setData(detail)
            setEditing(null)
            notify('success', form.id ? 'Date saved and checked' : 'Date added')
          }}
        />
      )}

      <ConfirmModal
        isOpen={replaceFile !== null}
        title="Replace the dates?"
        message={replaceFile && `Importing ${replaceFile.name} replaces the ${items.length} dates in this calendar, including any you have edited or checked. ${year.status === 'APPROVED' ? 'The approved dates stay in use until you approve again.' : ''}`}
        confirmLabel="Import and replace"
        danger
        onConfirm={async () => {
          const file = replaceFile
          setReplaceFile(null)
          if (file) await runImport(file, true)
        }}
        onClose={() => setReplaceFile(null)}
      />
      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete this date?"
        message={deleting && `${deleting.date ? fullDate(deleting.date) : 'This row'}${deleting.name ? ` (${deleting.name})` : ''} is removed from the ${year.year} calendar.`}
        confirmLabel="Delete date"
        danger
        onConfirm={async () => {
          if (deleting) await act(() => api.del<CalendarYearDetail>(`/api/calendar-years/${yearId}/items/${deleting.id}`), 'Date deleted')
        }}
        onClose={() => setDeleting(null)}
      />
      <ConfirmModal
        isOpen={approving}
        title={`Approve the ${year.year} calendar?`}
        message={
          <>
            From now on these <span className="font-semibold text-ink">{holidays.length} holidays</span> and{' '}
            <span className="font-semibold text-ink">{workingDays.length} adjustment working days</span> decide scheduling for {year.year}: no checks, alerts or Missed
            on holidays, and normal checks with alerts on adjustment working days. Weekly rules apply to every other date.
          </>
        }
        confirmLabel="Approve"
        onConfirm={async () => {
          try {
            await approve()
          } catch (err) {
            notify('error', 'Could not approve', errorText(err))
          }
        }}
        onClose={() => setApproving(false)}
      />
      <ConfirmModal
        isOpen={deletingYear}
        title={`Delete the ${year.year} draft?`}
        message="The draft, its dates and the uploaded document are deleted. It has never been approved, so no checks are affected."
        confirmLabel="Delete draft"
        danger
        onConfirm={removeYear}
        onClose={() => setDeletingYear(false)}
      />
    </div>
  )
}

const ReviewSummary: React.FC<{ year: CalendarYearDetail; blocking: number; checks: number; approveHint: string | null; general: CalendarIssue[] }> = ({
  year,
  blocking,
  checks,
  approveHint,
  general
}) => {
  const ready = !blocking && !checks && year.items.length > 0
  return (
    <div className="space-y-2">
      {year.year.extractionNote && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-line bg-slate-50 text-xs text-ink-secondary">
          <Info className="w-4 h-4 shrink-0 mt-px text-ink-muted" />
          <span>{year.year.extractionNote}</span>
        </div>
      )}
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 rounded-md border text-xs ${
          blocking ? 'border-failed-line bg-failed-bg' : checks ? 'border-exception-line bg-exception-bg' : 'border-success-line bg-success-bg'
        }`}
        role="status"
      >
        {blocking > 0 && (
          <span className="inline-flex items-center gap-1.5 font-semibold text-failed">
            <CircleAlert className="w-4 h-4" /> {blocking} problem{blocking === 1 ? '' : 's'} to fix
          </span>
        )}
        {checks > 0 && (
          <span className="inline-flex items-center gap-1.5 font-semibold text-exception">
            <AlertTriangle className="w-4 h-4" /> {checks} item{checks === 1 ? '' : 's'} to check against the document
          </span>
        )}
        {ready && (
          <span className="inline-flex items-center gap-1.5 font-semibold text-success">
            <CircleCheck className="w-4 h-4" />
            {year.year.status === 'APPROVED' && !year.year.pendingChanges ? 'All dates checked and approved' : 'All dates checked · ready to approve'}
          </span>
        )}
        {approveHint && !ready && <span className="text-ink-secondary">Approval is available once every row is fixed or checked.</span>}
        {year.year.status === 'APPROVED' && year.year.pendingChanges && (
          <span className="text-ink-secondary">The approved dates stay in use until these changes are approved.</span>
        )}
      </div>
      {general.map((issue, i) => (
        <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-md border border-failed-line bg-failed-bg text-xs text-failed">
          <CircleAlert className="w-4 h-4 shrink-0 mt-px" />
          {issue.message}
        </div>
      ))}
    </div>
  )
}

const ItemRow: React.FC<{
  item: CalendarYearItem
  holidays: CalendarYearItem[]
  issues: CalendarIssue[]
  canEdit: boolean
  onEdit: () => void
  onConfirm: () => void
  onDelete: () => void
}> = ({ item, holidays, issues, canEdit, onEdit, onConfirm, onDelete }) => {
  const style = CLOSURE_TYPES[item.type]
  const blocking = issues.filter((i) => i.severity === 'BLOCKING')
  const checks = issues.filter((i) => i.severity === 'CHECK')
  const info = issues.filter((i) => i.severity === 'INFO')
  const dateUncertain = !item.confirmed && item.uncertainFields.includes('date')
  const nameUncertain = !item.confirmed && item.uncertainFields.includes('name')
  const replaces = item.type === 'WORKING' && item.forHolidayDate ? holidays.find((h) => h.date === item.forHolidayDate) : null

  return (
    <tr className={blocking.length ? 'bg-failed-bg/40' : checks.length ? 'bg-exception-bg/40' : undefined} data-item-id={item.id}>
      <td className={`py-2 px-3 whitespace-nowrap ${dateUncertain ? 'text-exception' : ''}`}>
        {item.date ? (
          <>
            <div className="font-semibold text-ink tabular-nums">{fullDate(item.date)}</div>
            <div className="text-[11px] text-ink-muted">{weekdayName(item.date)}</div>
          </>
        ) : (
          <span className="font-semibold text-failed">Not readable</span>
        )}
      </td>
      <td className="py-2 px-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center ${style.chip}`} aria-hidden>{style.icon}</span>
          <span className="font-medium text-ink">{style.short}</span>
        </span>
      </td>
      <td className="py-2 px-3 min-w-[180px] max-w-[320px]">
        <div className={nameUncertain ? 'text-exception font-medium' : 'text-ink'}>{item.name || <span className="text-ink-faint">—</span>}</div>
        {item.type === 'WORKING' && (
          <div className="text-[11px] text-ink-muted">
            Replaces {replaces ? `${replaces.name ?? 'holiday'} (${fullDate(replaces.date!)})` : item.forHolidayDate ? fullDate(item.forHolidayDate) : '—'}
          </div>
        )}
        <div className="mt-1 text-[11px] text-ink-faint break-words">
          {item.sourceText ? (
            <>
              Document: {item.sourceText}
              {item.printedWeekday ? ` · day: ${item.printedWeekday}` : ''}
            </>
          ) : (
            'Added by hand'
          )}
        </div>
      </td>
      <td className="py-2 px-3 min-w-[200px] max-w-[360px]">
        {blocking.length === 0 && checks.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-success font-medium">
            <CheckCheck className="w-3.5 h-3.5" /> Checked
          </span>
        ) : (
          <ul className="space-y-1">
            {[...blocking, ...checks].map((issue, i) => (
              <li key={i} className={`flex items-start gap-1 text-[11px] ${issue.severity === 'BLOCKING' ? 'text-failed' : 'text-exception'}`}>
                {issue.severity === 'BLOCKING' ? <CircleAlert className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
        {info.map((issue, i) => (
          <div key={i} className="mt-1 flex items-start gap-1 text-[11px] text-ink-muted">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{issue.message}</span>
          </div>
        ))}
      </td>
      {canEdit && (
        <td className="py-2 px-3 text-right whitespace-nowrap">
          {checks.length > 0 && blocking.length === 0 && (
            <Button size="sm" variant="outline" onClick={onConfirm} icon={<CheckCheck className="w-3.5 h-3.5" />} title="The row matches the document">
              Confirm
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} icon={<Pencil className="w-3.5 h-3.5" />} aria-label={`Edit ${item.date ?? 'row'}`}>
            <span className="lg:hidden xl:inline">Edit</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} icon={<Trash2 className="w-3.5 h-3.5" />} className="text-failed hover:text-failed" aria-label={`Delete ${item.date ?? 'row'}`} />
        </td>
      )}
    </tr>
  )
}

const ItemModal: React.FC<{
  form: ItemForm
  year: number
  holidays: CalendarYearItem[]
  sourceText: string | null
  onClose: () => void
  onSave: (form: ItemForm) => Promise<void>
}> = ({ form: initial, year, holidays, sourceText, onClose, onSave }) => {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!form.date) return setError('Enter the date')
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={form.id ? 'Edit date' : 'Add date'}
      subtitle={form.id ? 'Saving marks the row as checked against the document' : `Add a date to the ${year} calendar`}
      maxWidth="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="calendar-item-form" variant="primary" loading={saving}>
            {form.id ? 'Save and mark checked' : 'Add date'}
          </Button>
        </>
      }
    >
      <form id="calendar-item-form" onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        {sourceText && (
          <div className="px-3 py-2 rounded-md border border-line bg-slate-50 text-[11px] text-ink-secondary">
            <span className="font-semibold text-ink">Read from document:</span> {sourceText}
          </div>
        )}
        <fieldset>
          <legend className="block text-[13px] lg:text-xs font-semibold text-slate-700 mb-1">
            Type<span className="text-failed"> *</span>
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Type">
            {ITEM_TYPES.map((t) => {
              const style = CLOSURE_TYPES[t]
              const active = form.type === t
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set('type', t)}
                  className={`flex items-center gap-2.5 text-left px-3 py-2 rounded-md border transition-colors ${active ? 'border-accent bg-blue-50/60 ring-1 ring-accent' : 'border-line-strong bg-white hover:bg-slate-50'}`}
                >
                  <span className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center ${style.chip}`} aria-hidden>{style.icon}</span>
                  <span className="text-xs font-semibold text-ink">{style.label}</span>
                </button>
              )
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date" required hint={form.date ? weekdayName(form.date) : undefined}>
            <DateInput value={form.date} min={`${year}-01-01`} max={`${year}-12-31`} onChange={(e) => set('date', e.target.value)} required />
          </Field>
          {form.type === 'WORKING' && (
            <Field label="Replaces holiday" hint="The holiday this working day makes up for">
              <Select value={form.forHolidayDate} onChange={(e) => set('forHolidayDate', e.target.value)}>
                <option value="">Not linked</option>
                {holidays
                  .filter((h) => h.date)
                  .sort((a, b) => a.date!.localeCompare(b.date!))
                  .map((h) => (
                    <option key={h.id} value={h.date!}>
                      {fullDate(h.date!)} · {h.name ?? 'Holiday'}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label={form.type === 'WORKING' ? 'Note' : 'Holiday name'} hint={form.type === 'WORKING' ? 'Optional' : undefined}>
          <TextInput value={form.name} maxLength={200} placeholder={form.type === 'WORKING' ? 'e.g. Adjustment for Diwali' : 'e.g. Diwali'} onChange={(e) => set('name', e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

/** The uploaded company document next to the extracted dates. Fetched with the admin's session, never public. */
const DocumentPreview: React.FC<{ yearId: string; year: CalendarYearDetail['year']; version: number }> = ({ yearId, year, version }) => {
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kind = !year.hasDocument
    ? null
    : year.sourceMimeType?.startsWith('image/')
      ? 'image'
      : year.sourceMimeType === 'application/pdf' || year.sourceFileName?.toLowerCase().endsWith('.pdf')
        ? 'pdf'
        : 'sheet'

  useEffect(() => {
    if (!kind || kind === 'sheet') return
    let objectUrl: string | null = null
    let cancelled = false
    fetchBlob(`/api/calendar-years/${yearId}/document`)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setError(null)
        setUrl(objectUrl)
      })
      .catch((err) => !cancelled && setError(errorText(err)))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [yearId, kind, version])

  return (
    <section className="bg-white border border-line rounded-lg shadow-2xs overflow-hidden 2xl:sticky 2xl:top-4" aria-label="Company document">
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-ink flex items-center gap-1.5 min-w-0">
          {kind === 'image' ? <ImageIcon className="w-4 h-4 text-ink-muted" /> : kind === 'sheet' ? <FileSpreadsheet className="w-4 h-4 text-ink-muted" /> : <FileText className="w-4 h-4 text-ink-muted" />}
          <span className="truncate">{year.sourceFileName ?? 'Company document'}</span>
        </h3>
        <span className="flex items-center gap-2 shrink-0">
          {year.extractionMethod && year.hasDocument && <span className="text-[11px] text-ink-muted whitespace-nowrap">{METHOD_LABEL[year.extractionMethod]}</span>}
          {kind && kind !== 'sheet' && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} className="2xl:hidden" aria-expanded={expanded}>
              {expanded ? 'Show less' : 'Show full'}
            </Button>
          )}
        </span>
      </div>
      {!kind ? (
        <p className="px-4 py-10 text-center text-xs text-ink-muted">No document imported. The company document is shown here for checking each date.</p>
      ) : kind === 'sheet' ? (
        <div className="px-4 py-8 text-center space-y-3">
          <p className="text-xs text-ink-muted">Spreadsheets can't be previewed here. Open the file to compare.</p>
          <Button size="sm" variant="outline" onClick={() => download(`/api/calendar-years/${yearId}/document`, undefined, year.sourceFileName ?? 'calendar')}>
            Download {year.sourceFileName}
          </Button>
        </div>
      ) : error ? (
        <p className="px-4 py-6 text-xs text-failed">{error}</p>
      ) : !url ? (
        <p className="px-4 py-10 text-center text-xs text-ink-muted">Loading document…</p>
      ) : kind === 'image' ? (
        <div className={`${expanded ? 'max-h-none' : 'max-h-[320px]'} 2xl:max-h-[75vh] overflow-auto bg-slate-100`}>
          <img src={url} alt={`${year.year} company calendar`} className="w-full h-auto" />
        </div>
      ) : (
        <iframe src={url} title={`${year.year} company calendar`} className={`w-full ${expanded ? 'h-[80vh]' : 'h-[360px]'} 2xl:h-[70vh] bg-slate-100`} />
      )}
    </section>
  )
}
