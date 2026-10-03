import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, ShieldCheck } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { formatBytes, formatDateTime } from '../../lib/format'
import { DELETE_PERMISSION_LABEL, type DeleteImpact, type DeleteImpactItem, type DeleteType } from '../../lib/deletePermissions'
import { Button } from './Button'
import { FormError, TextArea, TextInput } from './Form'
import { Modal } from './Modal'

const NOUN: Record<DeleteType, [string, string]> = {
  users: ['user', 'users'],
  jobs: ['job', 'jobs'],
  checks: ['quality check', 'quality checks']
}

const STATUS_LABEL: Record<string, string> = {
  PLANNED: 'Planned',
  STARTING: 'Starting',
  ACTIVE: 'Active',
  ENDING: 'Ending',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  PENDING: 'Pending',
  DUE: 'Due',
  IN_PROGRESS: 'In progress',
  MISSED: 'Missed',
  EXCEPTION: 'Exception',
  DISABLED: 'Disabled'
}

const ISO = /^\d{4}-\d{2}-\d{2}T/
const showValue = (v: string) => (ISO.test(v) ? formatDateTime(v) : v)
const statusText = (s: string) => STATUS_LABEL[s] ?? s

interface Props {
  /** Null keeps the dialog closed. */
  type: DeleteType | null
  ids: string[]
  /** True when the records were picked with checkboxes: needs the typed confirmation. */
  bulk?: boolean
  onClose: () => void
  onDeleted: (result: { deleted: number; filesRemoved: number; filesNotRemoved: string[] }) => void
  /** Users only: shown when the account has history and can only be disabled. */
  onDisableInstead?: () => void
}

/**
 * The permanent-delete dialog for users, jobs and quality checks.
 *
 * It asks the server what would be deleted (the delete impact), shows the records, everything that
 * goes with them, their evidence files and anything that blocks the delete, and needs a reason.
 * Bulk deletes also need "DELETE <count>" typed, and a second confirmation above the threshold.
 * The server re-checks all of it; this dialog never decides on its own what may be deleted.
 */
export const DeleteRecordsModal: React.FC<Props> = ({ type, ids, bulk = false, onClose, onDeleted, onDisableInstead }) => {
  const [impact, setImpact] = useState<DeleteImpact | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [step, setStep] = useState<'review' | 'large'>('review')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idsKey = ids.join(',')

  const load = useCallback(async () => {
    if (!type || !idsKey) return
    setLoading(true)
    setLoadError(null)
    setError(null)
    setStep('review')
    try {
      setImpact(await api.post<DeleteImpact>(`/api/deletions/${type}/impact`, { ids: idsKey.split(',') }))
    } catch (err) {
      setImpact(null)
      setLoadError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [type, idsKey])

  useEffect(() => {
    if (!type) return
    setReason('')
    setTyped('')
    load()
  }, [type, load])

  if (!type) return null
  const [one, many] = NOUN[type]
  const count = ids.length
  const phrase = `DELETE ${count}`
  const reasonOk = reason.trim().length > 0
  const typedOk = !bulk || typed.trim() === phrase
  const canDelete = !!impact && impact.blocked === 0 && impact.missing.length === 0 && impact.items.length > 0 && reasonOk && typedOk && !busy
  const onlyItem = !bulk ? impact?.items[0] : undefined
  const hasHistoryBlock = type === 'users' && !!impact?.items.some((i) => i.blockers.some((b) => /production history/.test(b)))

  const submit = async () => {
    if (!impact) return
    if (bulk && impact.needsSecondConfirmation && step === 'review') {
      setStep('large')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<{ deleted: number; filesRemoved: number; filesNotRemoved: string[] }>(`/api/deletions/${type}`, {
        ids,
        reason: reason.trim(),
        impactToken: impact.impactToken,
        bulk,
        ...(bulk ? { confirmation: typed.trim(), confirmLarge: step === 'large' } : {})
      })
      onDeleted(result)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setStep('review')
    } finally {
      setBusy(false)
    }
  }

  const title = bulk ? `Delete ${count} ${count === 1 ? one : many} permanently` : `Delete ${one} permanently`

  return (
    <Modal
      isOpen
      onClose={busy ? () => undefined : onClose}
      title={title}
      subtitle="This cannot be undone. The audit log keeps a record of who deleted what and why."
      maxWidth="xl"
      footer={
        step === 'large' ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setStep('review')} disabled={busy}>
              Back
            </Button>
            <Button size="sm" variant="danger" onClick={submit} loading={busy}>
              Yes, delete {impact?.totals.records} {many}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={submit} loading={busy} disabled={!canDelete}>
              {bulk ? `Delete ${count} ${count === 1 ? one : many}` : `Delete ${one}`}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-xs">
        {loading && <p className="text-ink-muted">Working out what will be deleted…</p>}
        {loadError && (
          <div className="space-y-2">
            <FormError message={loadError} />
            <Button size="sm" variant="outline" onClick={load}>
              Try again
            </Button>
          </div>
        )}

        {impact && !loading && step === 'large' && (
          <div className="rounded border border-failed-line bg-failed-bg p-3 space-y-2" role="alert">
            <p className="flex items-center gap-1.5 font-semibold text-failed">
              <AlertTriangle className="w-4 h-4" /> Large deletion: second confirmation
            </p>
            <p className="text-ink-secondary">
              You are about to permanently delete <b>{impact.totals.records}</b> {many} and <b>{impact.totals.files}</b> evidence files (
              {formatBytes(impact.totals.fileBytes)}). This is above the safety limit of {impact.thresholds.records} records or{' '}
              {impact.thresholds.files} evidence files.
            </p>
            <p className="text-ink-secondary">Reason: “{reason.trim()}”</p>
          </div>
        )}

        {impact && !loading && step === 'review' && (
          <>
            <div className="flex items-start gap-2 rounded border border-failed-line bg-failed-bg p-2.5 text-ink-secondary">
              <AlertTriangle className="w-4 h-4 text-failed shrink-0 mt-px" />
              {type === 'users' ? (
                <span>
                  The {count === 1 ? 'account is' : 'accounts are'} removed with {count === 1 ? 'its' : 'their'} signed-in devices and permissions. Only
                  accounts without production history can be deleted. Audit log entries keep the name and role.
                </span>
              ) : (
                <span>
                  The {count === 1 ? one : many} and everything listed below are removed from the database, and the evidence files are removed from
                  the server. Reports for that period will no longer include {count === 1 ? 'it' : 'them'}.
                </span>
              )}
            </div>

            {impact.missing.length > 0 && (
              <FormError message={`${impact.missing.length} of the selected records no longer exist. Close this dialog and select again.`} />
            )}

            {onlyItem ? <SingleItem item={onlyItem} showFiles={type !== 'users'} /> : <ItemList items={impact.items} />}

            {bulk && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label="Records" value={impact.totals.records} />
                <Stat label="Evidence files" value={type === 'users' ? '—' : impact.totals.files} />
                <Stat label="File size" value={type === 'users' ? '—' : formatBytes(impact.totals.fileBytes)} />
                <Stat label="Blocked" value={impact.blocked} danger={impact.blocked > 0} />
              </div>
            )}
            {bulk && impact.totals.dependents.some((d) => d.count > 0) && (
              <Dependents title="Also deleted" rows={impact.totals.dependents} />
            )}

            {impact.blocked > 0 && (
              <div className="rounded border border-failed-line bg-white p-2.5 text-failed space-y-1" role="alert">
                <p className="flex items-center gap-1.5 font-semibold">
                  <Ban className="w-3.5 h-3.5" /> {bulk ? `${impact.blocked} of the selected records cannot be deleted` : 'This record cannot be deleted'}
                </p>
                {bulk && <p className="text-ink-secondary">Clear those from the selection and try again. Nothing has been deleted.</p>}
                {hasHistoryBlock && onDisableInstead && (
                  <Button size="sm" variant="outline" onClick={onDisableInstead}>
                    Disable the account instead
                  </Button>
                )}
              </div>
            )}

            <p className="flex items-center gap-1.5 text-ink-muted">
              <ShieldCheck className="w-3.5 h-3.5" /> Required permission: <b className="text-ink-secondary">{DELETE_PERMISSION_LABEL[impact.permission]}</b>
            </p>

            {impact.blocked === 0 && impact.missing.length === 0 && (
              <>
                <label className="block">
                  <span className="block font-semibold text-slate-700 mb-1">
                    Reason for deleting <span className="text-failed">*</span>
                  </span>
                  <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Test data created during training" />
                  <span className="block text-[11px] text-ink-muted mt-1">Saved in the audit log.</span>
                </label>
                {bulk && (
                  <label className="block">
                    <span className="block font-semibold text-slate-700 mb-1">
                      Type <span className="font-mono text-failed">{phrase}</span> to confirm
                    </span>
                    <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" aria-label="Confirmation text" />
                  </label>
                )}
                {bulk && impact.needsSecondConfirmation && (
                  <p className="text-ink-muted">This is a large deletion. You will be asked to confirm a second time.</p>
                )}
              </>
            )}
          </>
        )}
        <FormError message={error} />
      </div>
    </Modal>
  )
}

const Stat: React.FC<{ label: string; value: React.ReactNode; danger?: boolean }> = ({ label, value, danger }) => (
  <div className="rounded border border-line bg-subtle px-2.5 py-2">
    <div className="text-[11px] text-ink-muted">{label}</div>
    <div className={`text-sm font-semibold tabular-nums ${danger ? 'text-failed' : 'text-ink'}`}>{value}</div>
  </div>
)

const Dependents: React.FC<{ title: string; rows: { label: string; count: number }[] }> = ({ title, rows }) => (
  <div>
    <p className="font-semibold text-slate-700 mb-1">{title}</p>
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
      {rows
        .filter((r) => r.count > 0)
        .map((r) => (
          <li key={r.label} className="flex justify-between gap-2 border-b border-dashed border-line py-0.5">
            <span className="text-ink-secondary">{r.label}</span>
            <span className="tabular-nums font-semibold text-ink">{r.count}</span>
          </li>
        ))}
    </ul>
  </div>
)

const SingleItem: React.FC<{ item: DeleteImpactItem; showFiles: boolean }> = ({ item, showFiles }) => {
  const shown = item.dependents.filter((d) => d.count > 0)
  const preserved = item.preserved.filter((d) => d.count > 0)
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 rounded border border-line p-2.5">
        {item.details.map((d) => (
          <div key={d.label} className="flex justify-between sm:block gap-2">
            <dt className="text-[11px] text-ink-muted">{d.label}</dt>
            <dd className="font-medium text-ink break-words text-right sm:text-left">{d.label === 'Status' ? statusText(d.value) : showValue(d.value)}</dd>
          </div>
        ))}
        {showFiles && (
          <div className="flex justify-between sm:block gap-2">
            <dt className="text-[11px] text-ink-muted">Evidence files</dt>
            <dd className="font-medium text-ink">
              {item.files} ({formatBytes(item.fileBytes)})
            </dd>
          </div>
        )}
      </dl>
      {shown.length > 0 && <Dependents title={item.blockers.some((b) => /history/.test(b)) ? 'Linked records' : 'Also deleted'} rows={shown} />}
      {preserved.length > 0 && <Dependents title="Kept" rows={preserved} />}
      {item.blockers.length > 0 && (
        <ul className="list-disc pl-5 text-failed space-y-0.5">
          {item.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ItemList: React.FC<{ items: DeleteImpactItem[] }> = ({ items }) => (
  <div className="max-h-56 overflow-y-auto rounded border border-line divide-y divide-line">
    {items.map((i) => (
      <div key={i.id} className={`px-2.5 py-1.5 ${i.blockers.length ? 'bg-failed-bg' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-ink truncate">{i.name}</span>
          <span className="text-ink-muted whitespace-nowrap">
            {statusText(i.status)}
            {i.files > 0 && ` · ${i.files} file${i.files === 1 ? '' : 's'}`}
          </span>
        </div>
        {i.blockers.map((b) => (
          <p key={b} className="text-[11px] text-failed">
            {b}
          </p>
        ))}
      </div>
    ))}
  </div>
)
