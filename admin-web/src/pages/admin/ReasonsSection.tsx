import React, { useState } from 'react'
import { Ban, Check, ListX, Minus, Pencil, Plus } from 'lucide-react'
import type { EvidenceRule, MonitoringReason } from '../../types'
import { Segmented } from '../../components/ui/Toolbar'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth, useModuleActions, useCanActivate, ACTIVATION_HINT } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'

/**
 * A list of reasons a worker may pick, managed on the Check Types page. Two lists use it, each
 * with its own address: the **Not Applicable** reasons for a single parameter
 * (/api/monitoring-reasons) and the **Exception** reasons for a whole check
 * (/api/exception-reasons). They are separate lists with the same fields, so this is one screen
 * for both.
 *
 * Access follows the Check Types module: anyone who may see check types, quality checks or
 * exceptions reads them; only Check Types **manage** may change them, and the backend enforces it.
 *
 * Deactivating never deletes: checks that already use a reason keep its text.
 */

interface ReasonsSectionProps {
  /** Heading, e.g. "N/A reasons". */
  title: string
  /** Explanation of the list, shown on the heading's info icon. */
  description: string
  /** Icon tile beside the heading. */
  icon?: React.ReactNode
  /** The API this list is stored in, e.g. "/api/monitoring-reasons". */
  endpoint: string
  /** Named in the dialog, e.g. "N/A Reason" → "Add N/A Reason". */
  noun: string
  dialogSubtitle: string
  placeholder: string
  /**
   * The exception reasons list: also whether the exception must name the PO No. / Item Code.
   * Shown to everyone who sees the list; only the Super Admin may change it (the backend enforces it).
   */
  jobDetails?: boolean
  /** The exception reasons list: also the photo and video evidence each reason asks for. */
  evidence?: boolean
}

interface ReasonForm {
  label: string
  requiresRemark: boolean
  requiresJobDetails: boolean
  photoEvidence: EvidenceRule
  videoEvidence: EvidenceRule
  /** A reading the worker must enter with the exception (empty label: none). */
  readingLabel: string
  readingUnit: string
  isActive: boolean
  sortOrder: string
}

const emptyReasonForm: ReasonForm = { label: '', requiresRemark: false, requiresJobDetails: true, photoEvidence: 'REQUIRED', videoEvidence: 'OFF', readingLabel: '', readingUnit: '', isActive: true, sortOrder: '0' }

const EVIDENCE_OPTIONS: { value: EvidenceRule; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'OPTIONAL', label: 'Optional' },
  { value: 'REQUIRED', label: 'Required' }
]

/** Off / Optional / Required in the list: required stands out, off is muted. */
const EvidenceCell: React.FC<{ rule: EvidenceRule }> = ({ rule }) =>
  rule === 'REQUIRED' ? (
    <span className="text-[12px] font-medium text-ink">Required</span>
  ) : rule === 'OPTIONAL' ? (
    <span className="text-[12px] text-ink-secondary">Optional</span>
  ) : (
    <span className="text-[12px] text-ink-muted">Off</span>
  )

/** Yes / no cell. The phone card shows the column name in front of it. */
const Flag: React.FC<{ on: boolean }> = ({ on }) =>
  on ? (
    <span className="inline-flex items-center gap-1 text-[12px] text-success font-medium">
      <Check className="w-3.5 h-3.5" aria-hidden />
      Yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted">
      <Minus className="w-3.5 h-3.5" aria-hidden />
      No
    </span>
  )

export const ReasonsSection: React.FC<ReasonsSectionProps> = ({ title, description, icon, endpoint, noun, dialogSubtitle, placeholder, jobDetails = false, evidence = false }) => {
  const canActivate = useCanActivate()
  const { can, user } = useAuth()
  const { canCreate, canEdit } = useModuleActions('activities')
  // Row actions: edit (Check Types edit) and deactivate (the Super Admin only).
  const canWrite = canEdit || canActivate
  /** Whether a reason needs the PO No. / Item Code is the Super Admin's decision. */
  const canSetJobDetails = user?.role === 'SUPER_ADMIN'
  const notify = useToast()

  // Readable with check types, quality checks or exceptions view.
  const canSee = can('activities') || can('checks') || can('exceptions')
  const reasons = useApi<MonitoringReason[]>(canSee ? endpoint : null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<MonitoringReason | null>(null)
  const [form, setForm] = useState<ReasonForm>(emptyReasonForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<MonitoringReason | null>(null)

  if (!canSee) return null

  const openAdd = () => {
    setEditing(null)
    setForm({ ...emptyReasonForm, sortOrder: String((reasons.data?.length ?? 0) + 1) })
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (r: MonitoringReason) => {
    setEditing(r)
    setForm({
      label: r.label,
      requiresRemark: r.requiresRemark,
      requiresJobDetails: r.requiresJobDetails ?? true,
      photoEvidence: r.photoEvidence ?? 'REQUIRED',
      videoEvidence: r.videoEvidence ?? 'OFF',
      readingLabel: r.readingLabel ?? '',
      readingUnit: r.readingUnit ?? '',
      isActive: r.isActive,
      sortOrder: String(r.sortOrder)
    })
    setFormError(null)
    setFormOpen(true)
  }

  const save = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const label = form.label.trim()
    if (!label) return setFormError('Enter the reason workers will see')
    if (evidence && !form.readingLabel.trim() && form.readingUnit.trim()) return setFormError('Enter the name of the reading, or clear its unit')
    const body = {
      label,
      requiresRemark: form.requiresRemark,
      // Sent only by the Super Admin; for anyone else the stored setting stays as it is.
      ...(jobDetails && canSetJobDetails ? { requiresJobDetails: form.requiresJobDetails } : {}),
      ...(evidence
        ? { photoEvidence: form.photoEvidence, videoEvidence: form.videoEvidence, readingLabel: form.readingLabel.trim() || null, readingUnit: form.readingUnit.trim() || null }
        : {}),
      isActive: form.isActive,
      sortOrder: Number(form.sortOrder) || 0
    }
    setSaving(true)
    setFormError(null)
    try {
      if (editing) await api.put(`${endpoint}/${editing.id}`, body)
      else await api.post(endpoint, body)
      notify('success', editing ? 'Reason updated' : 'Reason added', `${label} — available in the worker app now.`)
      setFormOpen(false)
      reasons.reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      await api.del(`${endpoint}/${deleting.id}`)
      notify('success', 'Reason deactivated', `${deleting.label} is no longer offered to workers. Past checks keep it.`)
      reasons.reload()
    } catch (err) {
      notify('error', 'Could not deactivate reason', errorText(err))
    }
  }

  return (
    <>
      <Card className="overflow-hidden flex flex-col">
        <CardHeader
          icon={icon}
          title={title}
          info={description}
          subtitle={reasons.data ? `${reasons.data.filter((r) => r.isActive).length} active · ${reasons.data.length} total` : undefined}
          actions={
            canCreate && (
              <Button size="sm" variant="outline" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
                Add Reason
              </Button>
            )
          }
        />
        {/* The loading / error states draw their own card; inside this card they lose the frame. */}
        <div className="[&>.card]:border-0 [&>.card]:shadow-none [&>.card]:rounded-none">
          <DataState loading={reasons.loading} error={reasons.error} onRetry={reasons.reload} empty={reasons.data === null ? undefined : false}>
            {(reasons.data ?? []).length === 0 ? (
              <EmptyState icon={<ListX className="w-5 h-5" />} title="No reasons yet. Add the first one." compact />
            ) : (
              <div className="overflow-x-auto lg:max-h-[420px] lg:overflow-y-auto">
                <table className="data-table stack-sm">
                  <thead>
                    <tr>
                      <th className="num w-12">Order</th>
                      <th>Reason</th>
                      <th>Requires remark</th>
                      {jobDetails && <th title="The exception must name the PO No. / Item Code as well as the machine">PO No. / Item Code</th>}
                      {evidence && <th title="Photo evidence with the exception">Photo</th>}
                      {evidence && <th title="Video evidence with the exception">Video</th>}
                      {evidence && <th title="A reading the worker must enter with the exception">Reading</th>}
                      <th>Status</th>
                      {canWrite && <th className="text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(reasons.data ?? []).map((r) => (
                      <tr key={r.id}>
                        <td className="num font-mono text-[11.5px] text-ink-muted">{r.sortOrder}</td>
                        <td className={`font-medium ${r.isActive ? 'text-ink' : 'text-ink-muted'}`}>{r.label}</td>
                        <td>
                          <Flag on={r.requiresRemark} />
                        </td>
                        {jobDetails && (
                          <td>
                            {r.requiresJobDetails === false ? (
                              <span className="text-[12px] text-ink-muted">Machine only</span>
                            ) : (
                              <Flag on />
                            )}
                          </td>
                        )}
                        {evidence && (
                          <td>
                            <EvidenceCell rule={r.photoEvidence ?? 'REQUIRED'} />
                          </td>
                        )}
                        {evidence && (
                          <td>
                            <EvidenceCell rule={r.videoEvidence ?? 'OFF'} />
                          </td>
                        )}
                        {evidence && (
                          <td className="whitespace-nowrap">
                            {r.readingLabel ? (
                              <span className="text-[12px] font-medium text-ink">
                                {r.readingLabel}
                                {r.readingUnit ? ` (${r.readingUnit})` : ''}
                              </span>
                            ) : (
                              <span className="text-[12px] text-ink-muted">—</span>
                            )}
                          </td>
                        )}
                        <td>
                          <StatusBadge status={r.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                        </td>
                        {canWrite && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex items-center gap-0.5">
                              {canEdit && (<IconButton label={`Edit ${r.label}`} onClick={() => openEdit(r)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>)}
                              {canActivate && (
                                <IconButton label={`Deactivate ${r.label}`} tone="danger" onClick={() => setDeleting(r)} disabled={!r.isActive}>
                                  <Ban className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataState>
        </div>
      </Card>

      {/* Add / edit an N/A reason */}
      <Modal
        isOpen={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editing ? `Edit ${noun}` : `Add ${noun}`}
        subtitle={dialogSubtitle}
        maxWidth="md"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => save()} loading={saving}>
              {editing ? 'Save Changes' : 'Add Reason'}
            </Button>
          </>
        }
      >
        <form onSubmit={save} className="space-y-3">
          <FormError message={formError} />
          <Field label="Reason" required hint="Short and clear, e.g. Machine stopped.">
            <TextInput value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder={placeholder} autoFocus />
          </Field>
          <Field label="Order" hint="Lower numbers are shown first in the worker app.">
            <input
              type="number"
              min={0}
              step={1}
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
              className={inputClass}
              aria-label="Order"
            />
          </Field>
          <Toggle
            checked={form.requiresRemark}
            onChange={(v) => setForm((f) => ({ ...f, requiresRemark: v }))}
            label="Requires remark"
            description="The worker must type an explanation when choosing this reason."
          />
          {evidence && (
            <div className="space-y-2.5 rounded-lg border border-line bg-panel p-3">
              <div className="text-[12.5px] font-medium text-ink-secondary">Evidence with the exception</div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] text-ink">Photo</span>
                <Segmented<EvidenceRule> label="Photo evidence" value={form.photoEvidence} onChange={(v) => setForm((f) => ({ ...f, photoEvidence: v }))} options={EVIDENCE_OPTIONS} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] text-ink">Video</span>
                <Segmented<EvidenceRule> label="Video evidence" value={form.videoEvidence} onChange={(v) => setForm((f) => ({ ...f, videoEvidence: v }))} options={EVIDENCE_OPTIONS} />
              </div>
              <p className="text-[11.5px] text-ink-muted">
                Required: the worker cannot send the exception without it. Optional: the worker may add it. Off: not asked.
              </p>
            </div>
          )}
          {evidence && (
            <div className="space-y-2.5 rounded-lg border border-line bg-panel p-3">
              <div className="text-[12.5px] font-medium text-ink-secondary">Reading with the exception</div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-2.5">
                <Field label="Reading" hint="e.g. Viscosity. Empty: no reading is asked.">
                  <TextInput value={form.readingLabel} onChange={(e) => setForm((f) => ({ ...f, readingLabel: e.target.value }))} placeholder="None" maxLength={60} />
                </Field>
                <Field label="Unit">
                  <TextInput value={form.readingUnit} onChange={(e) => setForm((f) => ({ ...f, readingUnit: e.target.value }))} placeholder="e.g. sec" maxLength={20} disabled={!form.readingLabel.trim()} />
                </Field>
              </div>
              <p className="text-[11.5px] text-ink-muted">With a reading set, the worker must enter it (a number above 0) before the exception can be sent.</p>
            </div>
          )}
          {jobDetails && (
            <Toggle
              checked={form.requiresJobDetails}
              onChange={(v) => setForm((f) => ({ ...f, requiresJobDetails: v }))}
              disabled={!canSetJobDetails}
              label="Requires PO No. / Item Code"
              description={
                canSetJobDetails
                  ? 'On: the exception must name the PO No. / Item Code as well as the machine. Off: the machine is enough (e.g. Machine stopped).'
                  : 'Only the Super Admin can change this.'
              }
            />
          )}
          <Toggle
            checked={form.isActive}
            disabled={!canActivate}
            onChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
            label="Active"
            description={canActivate ? 'Inactive reasons are not offered to workers; past checks keep them.' : ACTIVATION_HINT}
          />
          {/* Allows Enter to submit */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Deactivate reason?"
        danger
        confirmLabel="Deactivate"
        onConfirm={remove}
        onClose={() => setDeleting(null)}
        message={
          deleting && (
            <p>
              <span className="font-semibold text-ink">{deleting.label}</span> will no longer be offered to workers. Checks that already use it keep it.
            </p>
          )
        }
      />
    </>
  )
}
