import React, { useEffect, useState } from 'react'
import { Lock, Mail, Pencil, Plus, Settings2, Tags, Trash2 } from 'lucide-react'
import type { LeaveSettings, LeaveType } from '../../../types'
import { api, errorText } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { ACTIVATION_HINT, useAuth, useCanActivate } from '../../../lib/auth'
import { Button } from '../../../components/common/Button'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { DataState } from '../../../components/common/DataState'
import { Field, FormError, TextArea, TextInput, Toggle, inputClass } from '../../../components/common/Form'
import { Modal } from '../../../components/common/Modal'
import { PageHeader } from '../../../components/common/PageHeader'
import { StatusBadge } from '../../../components/common/StatusBadge'
import { useToast } from '../../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../../components/ui/Card'
import { CodeChip } from '../../../components/ui/Chips'
import { IconButton } from '../../../components/ui/Toolbar'

interface TypeForm {
  name: string
  code: string
  annualQuota: string
  isPaid: boolean
  allowHalfDay: boolean
  requiresAttachment: boolean
  isCustom: boolean
  maxConsecutiveDays: string
  advanceNoticeDays: string
  carryForwardMax: string
  isActive: boolean
  sortOrder: string
}

const emptyType: TypeForm = { name: '', code: '', annualQuota: '', isPaid: true, allowHalfDay: true, requiresAttachment: false, isCustom: false, maxConsecutiveDays: '', advanceNoticeDays: '0', carryForwardMax: '0', isActive: true, sortOrder: '0' }

const toForm = (t: LeaveType): TypeForm => ({
  name: t.name,
  code: t.code,
  annualQuota: t.annualQuota === null ? '' : String(t.annualQuota),
  isPaid: t.isPaid,
  allowHalfDay: t.allowHalfDay,
  requiresAttachment: t.requiresAttachment,
  isCustom: t.isCustom,
  maxConsecutiveDays: t.maxConsecutiveDays === null ? '' : String(t.maxConsecutiveDays),
  advanceNoticeDays: String(t.advanceNoticeDays),
  carryForwardMax: String(t.carryForwardMax),
  isActive: t.isActive,
  sortOrder: String(t.sortOrder)
})

const emailsToText = (list: string[]) => list.join('\n')
const textToEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))]
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const numberInput = (value: string, onChange: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
  <input type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} {...props} />
)

/** Leave types (add, edit, delete) and who gets the leave emails (Super Admin only). */
export const LeaveSettingsPage: React.FC = () => {
  const { can, isSuperAdmin } = useAuth()
  const canActivate = useCanActivate()
  const canCreate = can('leave_settings', 'create')
  const canEdit = can('leave_settings', 'edit')
  const canDelete = can('leave_settings', 'delete')
  const notify = useToast()
  const types = useApi<LeaveType[]>('/api/leave/types')
  const settings = useApi<LeaveSettings>('/api/leave/settings')

  // ---- leave types
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null)
  const [form, setForm] = useState<TypeForm>(emptyType)
  const [typeError, setTypeError] = useState<string | null>(null)
  const [savingType, setSavingType] = useState(false)
  const [deleting, setDeleting] = useState<LeaveType | null>(null)
  const removeType = async () => {
    if (!deleting) return
    try {
      const { result } = await api.del(`/api/leave/types/${deleting.id}`)
      if (result === 'disabled') notify('warning', 'Leave type switched off', `${deleting.name} is used by leave requests, so it was kept for their history and switched off instead of deleted.`)
      else notify('success', 'Leave type deleted', deleting.name)
      types.reload()
    } catch (err) {
      notify('error', 'Could not delete the leave type', errorText(err))
    }
  }
  const setT = <K extends keyof TypeForm>(k: K, v: TypeForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const saveType = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const n = (v: string) => (v.trim() === '' ? null : Number(v))
    const quota = n(form.annualQuota)
    const maxDays = n(form.maxConsecutiveDays)
    const notice = Number(form.advanceNoticeDays || 0)
    const carry = Number(form.carryForwardMax || 0)
    if (form.name.trim().length < 2 || !form.code.trim()) return setTypeError('Name and code are required')
    if (quota !== null && (!Number.isFinite(quota) || quota < 0 || quota > 366 || (quota * 2) % 1)) return setTypeError('Yearly quota: 0 to 366 days, in half days; leave it empty for no limit')
    if (maxDays !== null && (!Number.isFinite(maxDays) || maxDays < 0.5 || maxDays > 366)) return setTypeError('Longest leave: 0.5 to 366 days, or empty for no limit')
    if (!Number.isInteger(notice) || notice < 0 || notice > 365) return setTypeError('Advance notice: a whole number of days, 0 to 365')
    if (!Number.isFinite(carry) || carry < 0 || carry > 366) return setTypeError('Carry forward: 0 to 366 days')
    setSavingType(true)
    setTypeError(null)
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim(),
        annualQuota: quota,
        isPaid: form.isPaid,
        allowHalfDay: form.allowHalfDay,
        // Supporting documents are not used for leave.
        requiresAttachment: false,
        isCustom: form.isCustom,
        maxConsecutiveDays: maxDays,
        advanceNoticeDays: notice,
        carryForwardMax: carry,
        isActive: form.isActive,
        sortOrder: Number(form.sortOrder || 0)
      }
      if (editing === 'new') await api.post('/api/leave/types', body)
      else if (editing) await api.put(`/api/leave/types/${editing.id}`, body)
      notify('success', editing === 'new' ? 'Leave type added' : 'Leave type saved', body.name)
      setEditing(null)
      types.reload()
    } catch (err) {
      setTypeError(errorText(err))
    } finally {
      setSavingType(false)
    }
  }

  // ---- settings
  const [s, setS] = useState<LeaveSettings | null>(null)
  const [approverText, setApproverText] = useState('')
  const [ccText, setCcText] = useState('')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  useEffect(() => {
    if (!settings.data) return
    setS(settings.data)
    setApproverText(emailsToText(settings.data.notify.approverEmails))
    setCcText(emailsToText(settings.data.notify.ccEmails))
  }, [settings.data])

  const saveSettings = async () => {
    if (!s) return
    const approverEmails = textToEmails(approverText)
    const ccEmails = textToEmails(ccText)
    const bad = [...approverEmails, ...ccEmails, ...(s.notify.superAdminEmail ? [s.notify.superAdminEmail] : [])].find((e) => !EMAIL.test(e))
    if (isSuperAdmin && bad) return setSettingsError(`Not a valid email address: ${bad}`)
    const body: LeaveSettings = {
      ...s,
      // Only the Super Admin changes who gets the emails; others send them back unchanged.
      notify: isSuperAdmin ? { ...s.notify, approverEmails, ccEmails, superAdminEmail: s.notify.superAdminEmail.trim() } : settings.data!.notify
    }
    setSavingSettings(true)
    setSettingsError(null)
    try {
      await api.put('/api/leave/settings', body)
      notify('success', 'Leave settings saved')
      settings.reload()
    } catch (err) {
      setSettingsError(errorText(err))
    } finally {
      setSavingSettings(false)
    }
  }

  const setNotify = <K extends keyof LeaveSettings['notify']>(k: K, v: LeaveSettings['notify'][K]) => setS((x) => (x ? { ...x, notify: { ...x.notify, [k]: v } } : x))
  const notifyLocked = !isSuperAdmin

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Settings2 className="w-4.5 h-4.5" />}
        title="Leave Settings"
        description="Leave types, quotas and leave emails"
        info="Changes apply to new requests; requests already applied keep their counted days. Every change is in the Audit Logs."
      />

      {/* Leave types */}
      <Card className="overflow-hidden">
        <CardHeader
          icon={<Tags className="w-4 h-4" />}
          title="Leave types"
          subtitle="Yearly quota, paid or unpaid, half days, notice and carry forward"
          actions={
            canCreate && (
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => {
                  setForm(emptyType)
                  setTypeError(null)
                  setEditing('new')
                }}
              >
                Add leave type
              </Button>
            )
          }
        />
        <DataState loading={types.loading && !types.data} error={types.error} onRetry={types.reload} flush>
          {(types.data ?? []).length === 0 ? (
            <EmptyState icon={<Tags className="w-5 h-5" />} title="No leave types yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Leave type</th>
                    <th className="num">Yearly quota</th>
                    <th>Rules</th>
                    <th className="num">Carry forward</th>
                    <th>Status</th>
                    {(canEdit || canDelete) && (
                      <th className="text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(types.data ?? []).map((t) => (
                    <tr key={t.id}>
                      <td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <span className="font-semibold text-ink">{t.name}</span>
                          <CodeChip>{t.code}</CodeChip>
                        </span>
                      </td>
                      <td className="num whitespace-nowrap">{t.annualQuota === null ? 'No limit' : `${t.annualQuota} days`}</td>
                      <td className="text-ink-secondary">
                        {[
                          t.isPaid ? 'Paid' : 'Unpaid',
                          t.allowHalfDay ? 'half days' : 'full days only',
                          t.isCustom && 'employee enters the leave name',
                          t.advanceNoticeDays ? `${t.advanceNoticeDays} days' notice` : null,
                          t.maxConsecutiveDays !== null ? `at most ${t.maxConsecutiveDays} days at a time` : null
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </td>
                      <td className="num whitespace-nowrap">{t.carryForwardMax ? `up to ${t.carryForwardMax}` : '—'}</td>
                      <td>
                        <StatusBadge status={t.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                      </td>
                      {(canEdit || canDelete) && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            {canEdit && (
                              <IconButton
                                label={`Edit ${t.name}`}
                                onClick={() => {
                                  setForm(toForm(t))
                                  setTypeError(null)
                                  setEditing(t)
                                }}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>
                            )}
                            {canDelete && (
                              <IconButton label={`Delete ${t.name}`} tone="danger" onClick={() => setDeleting(t)}>
                                <Trash2 className="w-3.5 h-3.5" />
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
      </Card>

      <DataState loading={settings.loading && !s} error={settings.error} onRetry={settings.reload}>
        {s && (
          <>
            {/* Emails */}
            <Card>
              <CardHeader
                icon={<Mail className="w-4 h-4" />}
                title="Email notifications"
                subtitle={notifyLocked ? 'Set by the Super Admin' : 'Who receives the leave emails. Sent through the report email account (Reports › Sharing).'}
                actions={notifyLocked ? <Lock className="w-4 h-4 text-ink-faint" aria-label="Super Admin only" /> : undefined}
              />
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <Toggle checked={s.notify.approvers} disabled={notifyLocked} onChange={(v) => setNotify('approvers', v)} label="New requests to the approvers" description="Staff who may approve leave and have an email on their account (Workers & Users)." />
                  <Toggle checked={s.notify.worker} disabled={notifyLocked} onChange={(v) => setNotify('worker', v)} label="Decisions to the worker" description="When the worker’s account has an email. The worker always gets a notification in the app." />
                  <Toggle checked={s.notify.copySuperAdmin} disabled={notifyLocked} onChange={(v) => setNotify('copySuperAdmin', v)} label="Copy the Super Admin on every leave email" />
                </div>
                <div className="space-y-3">
                  <Field label="Super Admin email" hint="Gets a copy of the leave emails when switched on">
                    <TextInput type="email" value={s.notify.superAdminEmail} disabled={notifyLocked} onChange={(e) => setNotify('superAdminEmail', e.target.value)} placeholder="name@company.com" />
                  </Field>
                  <Field label="Approver / HR emails" hint="One per line; they receive new requests">
                    <TextArea value={approverText} disabled={notifyLocked} onChange={(e) => setApproverText(e.target.value)} rows={3} placeholder="hr@company.com" />
                  </Field>
                  <Field label="CC on every leave email" hint="One per line">
                    <TextArea value={ccText} disabled={notifyLocked} onChange={(e) => setCcText(e.target.value)} rows={2} />
                  </Field>
                </div>
              </div>
            </Card>

            {/* Only the email recipients are saved here: the Super Admin's. */}
            {isSuperAdmin && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-3">
                <FormError message={settingsError} />
                <Button variant="primary" onClick={saveSettings} loading={savingSettings}>
                  Save settings
                </Button>
              </div>
            )}
          </>
        )}
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add leave type' : 'Edit leave type'}
        maxWidth="lg"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={savingType}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="leave-type-form" loading={savingType}>
              {editing === 'new' ? 'Add' : 'Save'}
            </Button>
          </>
        }
      >
        <form id="leave-type-form" onSubmit={saveType} className="space-y-3">
          <FormError message={typeError} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name" required>
              <TextInput value={form.name} onChange={(e) => setT('name', e.target.value)} placeholder="e.g. Casual Leave" maxLength={60} autoFocus />
            </Field>
            <Field label="Code" required>
              <TextInput value={form.code} onChange={(e) => setT('code', e.target.value)} placeholder="e.g. CL" maxLength={12} className="font-mono uppercase" />
            </Field>
            <Field label="Yearly quota (days)" hint="Empty: no limit">
              {numberInput(form.annualQuota, (v) => setT('annualQuota', v), { min: 0, max: 366, step: 0.5, placeholder: 'No limit' })}
            </Field>
            <Field label="Carry forward (days)" hint="Unused days kept into the next leave year, at most">
              {numberInput(form.carryForwardMax, (v) => setT('carryForwardMax', v), { min: 0, max: 366, step: 0.5 })}
            </Field>
            <Field label="Advance notice (days)" hint="0: may be applied for the same day">
              {numberInput(form.advanceNoticeDays, (v) => setT('advanceNoticeDays', v), { min: 0, max: 365, step: 1 })}
            </Field>
            <Field label="Longest leave at a time (days)" hint="Empty: no limit">
              {numberInput(form.maxConsecutiveDays, (v) => setT('maxConsecutiveDays', v), { min: 0.5, max: 366, step: 0.5, placeholder: 'No limit' })}
            </Field>
            <Field label="Order in lists">{numberInput(form.sortOrder, (v) => setT('sortOrder', v), { min: 0, max: 999, step: 1 })}</Field>
          </div>
          <Toggle checked={form.isPaid} onChange={(v) => setT('isPaid', v)} label="Paid leave" />
          <Toggle checked={form.allowHalfDay} onChange={(v) => setT('allowHalfDay', v)} label="Half days allowed" />
          <Toggle checked={form.isCustom} onChange={(v) => setT('isCustom', v)} label="Employees type their own leave name" description="Custom leave: the employee enters the kind of leave (e.g. Marriage leave); approvers see it with the request." />
          <Toggle checked={form.isActive} disabled={!canActivate} onChange={(v) => setT('isActive', v)} label="Active" description={canActivate ? 'Inactive types cannot be chosen in the app; past requests keep them.' : ACTIVATION_HINT} />
        </form>
      </Modal>
      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete leave type"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <span className="font-semibold text-ink">{deleting?.name}</span>? Workers can no longer choose it. If leave requests already use it, it is kept for their
            history and only switched off (the Super Admin's).
          </>
        }
        onConfirm={removeType}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
