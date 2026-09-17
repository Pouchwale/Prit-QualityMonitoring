import React, { useMemo, useState } from 'react'
import { AlertTriangle, Edit2, Plus, Search, Trash2 } from 'lucide-react'
import type { Activity, Department, Machine, MachineStatus } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, MultiSelectList, Select, TextArea, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'

interface FormState {
  name: string
  code: string
  departmentId: string
  line: string
  model: string
  status: MachineStatus
  notes: string
  isActive: boolean
  activityIds: string[]
}

const emptyForm: FormState = {
  name: '',
  code: '',
  departmentId: '',
  line: '',
  model: '',
  status: 'ACTIVE',
  notes: '',
  isActive: true,
  activityIds: []
}

const STATUS_OPTIONS: { value: MachineStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active (running)' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'IDLE', label: 'Idle' }
]

export const MachinesPage: React.FC = () => {
  const canEdit = useCanManage('machines')
  const notify = useToast()
  const machinesApi = useApi<Machine[]>('/api/machines')
  const departmentsApi = useApi<Department[]>('/api/departments')
  const activitiesApi = useApi<Activity[]>('/api/activities')

  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('ALL')
  const [editing, setEditing] = useState<Machine | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Machine | null>(null)

  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const departments = departmentsApi.data ?? []
  const activities = useMemo(() => activitiesApi.data ?? [], [activitiesApi.data])
  const activityName = useMemo(() => new Map(activities.map((a) => [a.id, a.name])), [activities])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return machines.filter((m) => {
      if (deptFilter === 'NONE' && m.departmentId) return false
      if (deptFilter !== 'ALL' && deptFilter !== 'NONE' && m.departmentId !== deptFilter) return false
      if (!q) return true
      return [m.name, m.code, m.line, m.model, m.departmentName].some((v) => v?.toLowerCase().includes(q))
    })
  }, [machines, search, deptFilter])

  const openNew = () => {
    setForm(emptyForm)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (m: Machine) => {
    setForm({
      name: m.name,
      code: m.code,
      departmentId: m.departmentId ?? '',
      line: m.line ?? '',
      model: m.model ?? '',
      status: m.status,
      notes: m.notes ?? '',
      isActive: m.isActive,
      activityIds: m.activityIds
    })
    setFormError(null)
    setEditing(m)
  }

  const close = () => setEditing(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.code.trim()) {
      setFormError('Name and code are required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim(),
        departmentId: form.departmentId || null,
        line: form.line.trim() || null,
        model: form.model.trim() || null,
        status: form.status,
        notes: form.notes.trim() || null,
        isActive: form.isActive,
        activityIds: form.activityIds
      }
      if (editing === 'new') {
        await api.post('/api/machines', body)
        notify('success', 'Machine created', body.name)
      } else if (editing) {
        await api.put(`/api/machines/${editing.id}`, body)
        notify('success', 'Machine updated', body.name)
      }
      setEditing(null)
      machinesApi.reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      const { result } = await api.del(`/api/machines/${deleting.id}`)
      if (result === 'disabled') {
        notify('warning', 'Machine disabled', `${deleting.name} has check history or schedules, so it was disabled instead of deleted.`)
      } else {
        notify('success', 'Machine deleted', deleting.name)
      }
      machinesApi.reload()
    } catch (err) {
      notify('error', 'Could not delete machine', errorText(err))
    }
  }

  // Active departments, plus the machine's current one if it has since been deactivated.
  const departmentOptions = departments.filter((d) => d.isActive || d.id === form.departmentId)
  const activityItems = activities
    .filter((a) => a.isActive || form.activityIds.includes(a.id))
    .map((a) => ({
      id: a.id,
      label: a.isActive ? a.name : `${a.name} (inactive)`,
      detail: [a.departmentName, a.code].filter(Boolean).join(' · ')
    }))

  const pickerError = departmentsApi.error || activitiesApi.error

  return (
    <div className="space-y-4">
      <PageHeader
        title="Machines"
        description="Production machines and the quality check types performed on each"
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Machine
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search name, code, line or model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-[40px] lg:h-8 pl-8 pr-3 border border-line-strong rounded text-[16px] lg:text-xs bg-white placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Department:</span>
          <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="w-auto min-w-[160px]">
            <option value="ALL">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value="NONE">No department</option>
          </Select>
        </div>
      </div>

      <DataState
        loading={machinesApi.loading}
        error={machinesApi.error}
        onRetry={machinesApi.reload}
        empty={!machinesApi.loading && filtered.length === 0}
        emptyText={machines.length === 0 ? 'No machines yet' : 'No machines match the filters'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Machine</th>
                <th className="py-2.5 px-3.5">Code</th>
                <th className="py-2.5 px-3.5">Department</th>
                <th className="py-2.5 px-3.5">Line</th>
                <th className="py-2.5 px-3.5">Model</th>
                <th className="py-2.5 px-3.5">Status</th>
                <th className="py-2.5 px-3.5">Check types</th>
                <th className="py-2.5 px-3.5">Enabled</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((m) => {
                const names = m.activityIds.map((id) => activityName.get(id)).filter(Boolean)
                return (
                  <tr key={m.id} className={`hover:bg-slate-50 transition-colors ${m.isActive ? '' : 'text-ink-muted'}`}>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <span className={`font-semibold ${m.isActive ? 'text-ink' : 'text-ink-muted'}`}>{m.name}</span>
                      {m.notes && <span className="block text-[11px] lg:text-[10px] text-ink-muted truncate max-w-xs">{m.notes}</span>}
                    </td>
                    <td className="py-2.5 px-3.5 font-mono text-ink-secondary whitespace-nowrap">{m.code}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">{m.departmentName ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-ink-secondary">{m.line ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-ink-secondary">{m.model ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <StatusBadge status={m.status} size="sm" />
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap" title={names.join(', ')}>
                      {m.activityIds.length === 0 ? (
                        <span className="text-ink-faint">None</span>
                      ) : (
                        <span className="text-ink">
                          {m.activityIds.length} {m.activityIds.length === 1 ? 'type' : 'types'}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      {m.isActive ? <span className="text-success font-medium">Enabled</span> : <StatusBadge status="DISABLED" size="sm" />}
                    </td>
                    {canEdit && (
                      <td className="py-2 px-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => openEdit(m)} icon={<Edit2 className="w-3 h-3 text-ink-muted" />}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(m)} title="Delete" aria-label={`Delete ${m.name}`} icon={<Trash2 className="w-3.5 h-3.5 text-failed" />} />
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Machine' : 'Edit Machine'}
        subtitle="Machine details and the quality check types performed on it"
        maxWidth="lg"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="machine-form" loading={saving}>
              {editing === 'new' ? 'Create Machine' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="machine-form" onSubmit={submit} className="space-y-3">
          <FormError message={formError} />
          {pickerError && <FormError message={`Could not load lists: ${pickerError}`} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name" required>
              <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Printing Machine 03" maxLength={120} autoFocus />
            </Field>
            <Field label="Code" required>
              <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. PRT-03" maxLength={40} className="font-mono" />
            </Field>
            <Field label="Department">
              <Select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">No department</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.isActive ? d.name : `${d.name} (inactive)`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Line">
              <TextInput value={form.line} onChange={(e) => set('line', e.target.value)} placeholder="e.g. Line 2" maxLength={200} />
            </Field>
            <Field label="Model">
              <TextInput value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="e.g. Rotomec 8-Color" maxLength={200} />
            </Field>
            <Field label="Status">
              <Select value={form.status} onChange={(e) => set('status', e.target.value as MachineStatus)}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {(form.status !== 'ACTIVE' || !form.isActive) && (
            <div className="flex items-start gap-2 px-3 py-2 rounded border border-exception-line bg-exception-bg text-[11px] text-exception">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {form.isActive
                  ? `Machines in ${form.status === 'MAINTENANCE' ? 'Maintenance' : 'Idle'} get no scheduled checks.`
                  : 'Disabled machines get no scheduled checks.'}{' '}
                Changing the status or enabled state removes its upcoming checks.
              </span>
            </div>
          )}

          <Field label="Notes">
            <TextArea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={500} placeholder="Optional notes for supervisors" />
          </Field>

          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-xs font-semibold text-slate-700">Check types on this machine</span>
              <span className="text-[11px] text-ink-muted">{form.activityIds.length} selected</span>
            </div>
            <MultiSelectList
              items={activityItems}
              selected={form.activityIds}
              onChange={(ids) => set('activityIds', ids)}
              emptyText={activitiesApi.loading ? 'Loading check types…' : 'No check types configured yet'}
            />
            <span className="block text-[11px] text-ink-muted mt-1">
              The quality checks performed on this machine. Set how often each runs on the Schedules page.
            </span>
          </div>

          <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} label="Enabled" description="Disabled machines are hidden from workers and get no checks." />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete machine"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <span className="font-semibold text-ink">{deleting?.name}</span>? Its upcoming checks are removed. If it has check history
            or schedules, it will be disabled instead so history is kept.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
