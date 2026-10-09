import React, { useState } from 'react'
import { AlertCircle, BellRing, CheckCircle2, Phone, Smartphone, Trash2, User, RefreshCw, Send } from 'lucide-react'
import type { ModuleDeviceAssignment, ModuleDevicesResponse, QualityModule } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { Modal } from '../../components/common/Modal'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { Field, FormError, Select } from '../../components/common/Form'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'

export const NotificationDevicesSection: React.FC = () => {
  const notify = useToast()
  const canActivities = useCanManage('activities')
  const canSettings = useCanManage('settings')
  const canManage = canActivities || canSettings
  const { data, loading, reload } = useApi<ModuleDevicesResponse>('/api/notifications/module-devices')

  const [assignModalModule, setAssignModalModule] = useState<QualityModule | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [removingModule, setRemovingModule] = useState<QualityModule | null>(null)
  const [testingModule, setTestingModule] = useState<QualityModule | null>(null)

  const ipqc = data?.ipqc ?? { module: 'IPQC', userId: null, userName: null, userPhone: null, employeeId: null }
  const qc = data?.qc ?? { module: 'QC', userId: null, userName: null, userPhone: null, employeeId: null }
  const workers = data?.workers ?? []

  const openAssignModal = (module: QualityModule) => {
    const current = module === 'IPQC' ? ipqc : qc
    setSelectedUserId(current.userId ?? '')
    setFormError(null)
    setAssignModalModule(module)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!assignModalModule) return
    if (!selectedUserId) {
      setFormError('Please select a worker / phone')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const payload = assignModalModule === 'IPQC'
        ? { ipqcUserId: selectedUserId }
        : { qcUserId: selectedUserId }

      await api.put('/api/notifications/module-devices', payload)
      notify('success', 'Notification device updated', `${assignModalModule} checks will now notify the assigned device.`)
      setAssignModalModule(null)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!removingModule) return
    setSaving(true)
    try {
      const payload = removingModule === 'IPQC'
        ? { ipqcUserId: null }
        : { qcUserId: null }

      await api.put('/api/notifications/module-devices', payload)
      notify('info', 'Assignment removed', `${removingModule} dedicated phone assignment has been removed.`)
      setRemovingModule(null)
      reload()
    } catch (err) {
      notify('error', 'Failed to remove', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const handleTestNotification = async (module: QualityModule) => {
    setTestingModule(module)
    try {
      await api.post('/api/notifications/module-devices/test', { module })
      notify('success', `Test alert sent (${module})`, `Alert sent to the assigned ${module} phone/device.`)
    } catch (err) {
      notify('error', `Test alert failed (${module})`, errorText(err))
    } finally {
      setTestingModule(null)
    }
  }

  const workerOptions = [
    { value: '', label: '-- Select Worker / Phone --' },
    ...workers.map((w) => ({
      value: w.id,
      label: `${w.name} (${w.employeeId})${w.phone ? ` • ${w.phone}` : ''}`
    }))
  ]

  const renderModuleCard = (assignment: ModuleDeviceAssignment, title: string, subtitle: string) => {
    const isAssigned = Boolean(assignment.userId)
    const isTesting = testingModule === assignment.module

    return (
      <div className="flex flex-col rounded-lg border border-line bg-white">
        <div className="flex items-start justify-between gap-3 px-3.5 pt-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center h-5 px-1.5 rounded bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent-line font-mono text-[11.5px] font-semibold tracking-wide">
                {assignment.module}
              </span>
              <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
            </div>
            <p className="text-[11.5px] text-ink-muted mt-1 leading-snug">{subtitle}</p>
          </div>

          {isAssigned ? (
            <span className="shrink-0 inline-flex items-center gap-1 h-[22px] px-2 rounded-full bg-success-bg text-success ring-1 ring-inset ring-success-line text-[11.5px] font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Configured
            </span>
          ) : (
            <span className="shrink-0 inline-flex items-center gap-1 h-[22px] px-2 rounded-full bg-exception-bg text-exception ring-1 ring-inset ring-exception-line text-[11.5px] font-medium">
              <AlertCircle className="w-3.5 h-3.5" aria-hidden /> No Phone Assigned
            </span>
          )}
        </div>

        <div className="mx-3.5 my-3 px-3 py-2.5 rounded-md bg-subtle border border-line">
          <div className="text-[11px] text-ink-muted uppercase font-semibold tracking-[0.05em] mb-1.5">Dedicated Notification Phone / User</div>
          {isAssigned ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-8 h-8 shrink-0 rounded-full bg-white ring-1 ring-line text-ink-secondary flex items-center justify-center" aria-hidden>
                <User className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink truncate">
                  {assignment.userName}
                  {assignment.employeeId && <span className="ml-1.5 font-mono text-[11.5px] font-normal text-ink-muted">{assignment.employeeId}</span>}
                </div>
                {assignment.userPhone ? (
                  <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary tabular-nums">
                    <Phone className="w-3 h-3 text-ink-muted" aria-hidden />
                    <span>{assignment.userPhone}</span>
                  </div>
                ) : (
                  <div className="text-[11.5px] text-ink-muted italic">No phone number recorded on profile</div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-ink-secondary">
              No worker / phone assigned. Notifications for {assignment.module} checks will not be dispatched.
            </p>
          )}
        </div>

        {canManage && (
          <div className="mt-auto flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-line">
            <Button variant={isAssigned ? 'outline' : 'primary'} size="sm" onClick={() => openAssignModal(assignment.module)} icon={<Smartphone className="w-3.5 h-3.5" />}>
              {isAssigned ? 'Change Phone' : 'Assign Phone / User'}
            </Button>

            {isAssigned && (
              <div className="flex items-center gap-0.5">
                <IconButton
                  label={isTesting ? `Sending test alert to the ${assignment.module} phone` : `Send a test alert to the ${assignment.module} phone (voice and push)`}
                  onClick={() => handleTestNotification(assignment.module)}
                  disabled={isTesting}
                >
                  {isTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                </IconButton>
                <IconButton label={`Remove the ${assignment.module} phone`} tone="danger" onClick={() => setRemovingModule(assignment.module)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader
        icon={<BellRing className="w-4 h-4" />}
        title="Notification devices"
        subtitle="IPQC checks alert the IPQC phone, QC checks the QC phone"
        info="Module-based notification routing: IPQC checks route to the dedicated IPQC phone, and QC checks route to the dedicated QC phone. Both can be the same phone or separate phones."
        actions={
          <IconButton label="Reload device status" onClick={() => reload()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {renderModuleCard(ipqc, 'IPQC Notification Phone', 'Registration, Viscosity, Colour, and other in-process parameters')}
        {renderModuleCard(qc, 'QC Notification Phone', 'Pouch Length, Pouch Size, Zipper, Closer, and other finished QC parameters')}
      </div>

      {/* Modal to assign or change phone */}
      <Modal
        isOpen={Boolean(assignModalModule)}
        title={assignModalModule ? `Assign Dedicated Phone for ${assignModalModule}` : ''}
        subtitle="Receives push and voice alerts when a check is due"
        onClose={() => setAssignModalModule(null)}
        maxWidth="md"
        footer={
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setAssignModalModule(null)}>
              Cancel
            </Button>
            <Button type="submit" form="assign-device-form" size="sm" variant="primary" disabled={saving || !selectedUserId}>
              {saving ? 'Saving...' : 'Save Configuration'}
            </Button>
          </>
        }
      >
        <form id="assign-device-form" onSubmit={handleSave} className="space-y-3">
          <p className="text-[12.5px] text-ink-secondary">
            Select the worker/device that will receive push and voice alerts whenever an <strong className="text-ink">{assignModalModule}</strong> check becomes due.
            The same phone can be assigned to both IPQC and QC, or separated anytime.
          </p>

          <Field label="Dedicated Notification Worker / Phone" required>
            <Select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
              {workerOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>

          {formError && <FormError message={formError} />}
        </form>
      </Modal>

      {/* Confirm modal to remove assignment */}
      <ConfirmModal
        isOpen={Boolean(removingModule)}
        title={`Remove ${removingModule ?? ''} Notification Phone?`}
        message={`Are you sure you want to remove the dedicated phone assignment for ${removingModule ?? ''}? While unassigned, push notifications for ${removingModule ?? ''} checks will be paused until a new device is assigned.`}
        confirmLabel="Remove Assignment"
        danger
        onClose={() => setRemovingModule(null)}
        onConfirm={handleRemove}
      />
    </Card>
  )
}
