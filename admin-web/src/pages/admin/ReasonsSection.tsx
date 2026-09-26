import React, { useState } from 'react'
import { Check, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MonitoringReason } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth, useCanManage } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'

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
  description: string
  /** The API this list is stored in, e.g. "/api/monitoring-reasons". */
  endpoint: string
  /** Named in the dialog, e.g. "N/A Reason" → "Add N/A Reason". */
  noun: string
  dialogSubtitle: string
  placeholder: string
}

interface ReasonForm {
  label: string
  requiresRemark: boolean
  isActive: boolean
  sortOrder: string
}

const emptyReasonForm: ReasonForm = { label: '', requiresRemark: false, isActive: true, sortOrder: '0' }

/** Yes / no cell. The phone card shows the column name in front of it. */
const Flag: React.FC<{ on: boolean }> = ({ on }) =>
  on ? (
    <span className="inline-flex items-center gap-1 text-success font-medium">
      <Check className="w-3.5 h-3.5" />
      Yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-ink-faint">
      <Minus className="w-3.5 h-3.5" />
      No
    </span>
  )

export const ReasonsSection: React.FC<ReasonsSectionProps> = ({ title, description, endpoint, noun, dialogSubtitle, placeholder }) => {
  const { can } = useAuth()
  const canEdit = useCanManage('activities')
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
    setForm({ label: r.label, requiresRemark: r.requiresRemark, isActive: r.isActive, sortOrder: String(r.sortOrder) })
    setFormError(null)
    setFormOpen(true)
  }

  const save = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const label = form.label.trim()
    if (!label) return setFormError('Enter the reason workers will see')
    const body = {
      label,
      requiresRemark: form.requiresRemark,
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
      <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden">
        <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-ink">{title}</h2>
            <p className="text-[11px] text-ink-muted">{description}</p>
          </div>
          {canEdit && (
            <Button size="sm" variant="primary" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Reason
            </Button>
          )}
        </div>
        <DataState
          loading={reasons.loading}
          error={reasons.error}
          onRetry={reasons.reload}
          empty={reasons.data === null ? undefined : reasons.data.length === 0}
          emptyText="No reasons yet. Add the first one."
        >
          <div className="overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2 px-3 font-semibold">Reason</th>
                  <th className="py-2 px-3 font-semibold">Requires remark</th>
                  <th className="py-2 px-3 font-semibold">Order</th>
                  <th className="py-2 px-3 font-semibold">Status</th>
                  {canEdit && <th className="py-2 px-3 font-semibold text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(reasons.data ?? []).map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-2 px-3 font-medium text-ink">{r.label}</td>
                    <td className="py-2 px-3">
                      <Flag on={r.requiresRemark} />
                    </td>
                    <td className="py-2 px-3 font-mono text-ink-secondary">{r.sortOrder}</td>
                    <td className="py-2 px-3">
                      <StatusBadge status={r.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                    </td>
                    {canEdit && (
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => openEdit(r)} icon={<Pencil className="w-3 h-3" />}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleting(r)}
                            disabled={!r.isActive}
                            icon={<Trash2 className="w-3 h-3 text-failed" />}
                            title="Deactivate reason"
                            aria-label={`Deactivate ${r.label}`}
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </section>

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
          <Toggle
            checked={form.isActive}
            onChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
            label="Active"
            description="Inactive reasons are not offered to workers; past checks keep them."
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
