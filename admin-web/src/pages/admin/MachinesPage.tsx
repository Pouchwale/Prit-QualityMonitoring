import React, { useMemo, useState } from 'react'
import { Activity, AlertTriangle, ClipboardList, Cpu, PauseCircle, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react'
import type { Activity as CheckType, Department, Machine, MachineStatus } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useModuleActions, useCanActivate, ACTIVATION_HINT } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, MultiSelectList, Select, TextArea, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Card, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'

interface FormState {
  name: string
  code: string
  departmentIds: string[]
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
  departmentIds: [],
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

/** A small neutral chip, e.g. a machine code or a check type name. */
const chip = 'inline-flex items-center h-5 px-1.5 rounded bg-subtle ring-1 ring-inset ring-line text-[11px] text-ink-secondary whitespace-nowrap'

export const MachinesPage: React.FC = () => {
  const canActivate = useCanActivate()
  const { canCreate, canEdit, canDelete, canWrite } = useModuleActions('machines')
  const notify = useToast()
  const machinesApi = useApi<Machine[]>('/api/machines')
  const departmentsApi = useApi<Department[]>('/api/departments')
  const activitiesApi = useApi<CheckType[]>('/api/activities')

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
      if (deptFilter === 'NONE' && m.departmentIds.length) return false
      if (deptFilter !== 'ALL' && deptFilter !== 'NONE' && !m.departmentIds.includes(deptFilter)) return false
      if (!q) return true
      return [m.name, m.code, m.line, m.model, ...m.departments.map((d) => d.name)].some((v) => v?.toLowerCase().includes(q))
    })
  }, [machines, search, deptFilter])
  const page = usePagination(filtered, 25, `${search}|${deptFilter}`)

  // KPI strip: machine statuses counted from the list already loaded.
  const counts = useMemo(() => {
    const c: Record<MachineStatus, number> = { ACTIVE: 0, MAINTENANCE: 0, IDLE: 0 }
    for (const m of machines) c[m.status] = (c[m.status] ?? 0) + 1
    return c
  }, [machines])
  const disabledCount = machines.filter((m) => !m.isActive).length

  const openNew = () => {
    setForm(emptyForm)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (m: Machine) => {
    setForm({
      name: m.name,
      code: m.code,
      departmentIds: m.departmentIds,
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
        // The first one is the main department (the server keeps departmentId in step).
        departmentIds: form.departmentIds,
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

  // Active departments, plus any of the machine's own that have since been deactivated.
  const departmentItems = departments
    .filter((d) => d.isActive || form.departmentIds.includes(d.id))
    .map((d) => ({ id: d.id, label: d.isActive ? d.name : `${d.name} (inactive)`, detail: d.code }))
  const activityItems = activities
    .filter((a) => a.isActive || form.activityIds.includes(a.id))
    .map((a) => ({
      id: a.id,
      label: a.isActive ? a.name : `${a.name} (inactive)`,
      detail: [a.departmentName, a.code].filter(Boolean).join(' · ')
    }))

  const pickerError = departmentsApi.error || activitiesApi.error

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Cpu className="w-4.5 h-4.5" />}
        title="Machines"
        description={
          machinesApi.data
            ? `${machines.length} ${machines.length === 1 ? 'machine' : 'machines'} · ${counts.MAINTENANCE} in maintenance`
            : 'Production machines and their check types'
        }
        info="Production machines and the quality check types performed on each. Set how often each check runs on the Schedules page."
        actions={
          canCreate && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Machine
            </Button>
          )
        }
      />

      {machines.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Total" value={machines.length} icon={<Cpu className="w-4 h-4" />} meta={disabledCount ? `${disabledCount} disabled` : 'All enabled'} />
          <StatCard label="Active" value={counts.ACTIVE} icon={<Activity className="w-4 h-4" />} tone="success" meta="Running" />
          <StatCard
            label="Maintenance"
            value={counts.MAINTENANCE}
            icon={<Wrench className="w-4 h-4" />}
            tone={counts.MAINTENANCE ? 'exception' : 'neutral'}
            meta="No scheduled checks"
          />
          <StatCard label="Idle" value={counts.IDLE} icon={<PauseCircle className="w-4 h-4" />} meta="No scheduled checks" />
        </div>
      )}

      <DataState
        loading={machinesApi.loading}
        error={machinesApi.error}
        onRetry={machinesApi.reload}
        empty={!machinesApi.loading && machines.length === 0}
        emptyText="No machines yet"
      >
        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search machines" placeholder="Search machines…" />
            <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="sm:w-auto sm:min-w-[180px]" aria-label="Department">
              <option value="ALL">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value="NONE">No department</option>
            </Select>
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={machines.length} noun="machines" />
          </Toolbar>
          {filtered.length === 0 ? (
            <EmptyState icon={<Search className="w-5 h-5" />} title="No machines match the filters" compact />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Machine</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Check types</th>
                    <th>Enabled</th>
                    {canWrite && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {page.visible.map((m) => {
                    const names = m.activityIds.map((id) => activityName.get(id)).filter((n): n is string => Boolean(n))
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`font-semibold whitespace-nowrap ${m.isActive ? 'text-ink' : 'text-ink-muted'}`}>{m.name}</span>
                            <span className={`${chip} font-mono`} title="Machine code">
                              {m.code}
                            </span>
                          </div>
                          {m.notes && <span className="block text-[11.5px] text-ink-muted truncate max-w-xs">{m.notes}</span>}
                        </td>
                        <td>
                          <span className="text-ink-secondary">
                            {m.departments.length ? m.departments.map((d) => d.name).join(', ') : <span className="text-ink-faint">—</span>}
                          </span>
                          {(m.line || m.model) && (
                            <span className="block text-[11.5px] text-ink-muted whitespace-nowrap">
                              {[m.line && `Line: ${m.line}`, m.model && `Model: ${m.model}`].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={m.status} size="sm" />
                        </td>
                        <td title={names.join(', ')}>
                          {m.activityIds.length === 0 ? (
                            <span className="text-ink-faint">None</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent-line text-[11px] font-semibold tabular-nums whitespace-nowrap">
                                <ClipboardList className="w-3 h-3" aria-hidden />
                                {m.activityIds.length} {m.activityIds.length === 1 ? 'type' : 'types'}
                              </span>
                              {names.slice(0, 2).map((n) => (
                                <span key={n} className={`${chip} hidden xl:inline-flex max-w-[150px] truncate rounded-full`}>
                                  <span className="truncate">{n}</span>
                                </span>
                              ))}
                              {names.length > 2 && <span className="hidden xl:inline text-[11px] text-ink-muted tabular-nums">+{names.length - 2}</span>}
                            </div>
                          )}
                        </td>
                        <td>
                          {m.isActive ? (
                            <span className="text-[12px] font-medium text-success whitespace-nowrap">Enabled</span>
                          ) : (
                            <StatusBadge status="DISABLED" size="sm" />
                          )}
                        </td>
                        {canWrite && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex gap-0.5">
                              {canEdit && (<IconButton label={`Edit ${m.name}`} onClick={() => openEdit(m)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>)}
                              {canDelete && (<IconButton label={`Delete ${m.name}`} tone="danger" onClick={() => setDeleting(m)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </IconButton>)}
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page.page} pages={page.pages} total={page.total} pageSize={page.pageSize} onPage={page.setPage} noun="machines" />
        </Card>
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
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-exception-line bg-exception-bg text-[12px] text-exception" role="note">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
              <span>
                {form.isActive
                  ? `Machines in ${form.status === 'MAINTENANCE' ? 'Maintenance' : 'Idle'} get no scheduled checks.`
                  : 'Disabled machines get no scheduled checks.'}{' '}
                Changing the status or enabled state removes its upcoming checks.
              </span>
            </div>
          )}

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[12.5px] font-medium text-ink-secondary">Departments</span>
              <span className="text-[11px] text-ink-muted tabular-nums">{form.departmentIds.length} selected</span>
            </div>
            <MultiSelectList
              items={departmentItems}
              selected={form.departmentIds}
              onChange={(ids) => set('departmentIds', ids)}
              emptyText={departmentsApi.loading ? 'Loading departments…' : 'No departments configured yet'}
            />
            <span className="block text-[11px] text-ink-muted mt-1">Every department this machine works for. One machine can serve several.</span>
          </div>

          <Field label="Notes">
            <TextArea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={500} placeholder="Optional notes for supervisors" />
          </Field>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[12.5px] font-medium text-ink-secondary">Check types on this machine</span>
              <span className="text-[11px] text-ink-muted tabular-nums">{form.activityIds.length} selected</span>
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

          <Toggle checked={form.isActive} disabled={!canActivate} onChange={(v) => set('isActive', v)} label="Enabled" description={canActivate ? 'Disabled machines are hidden from workers and get no checks.' : ACTIVATION_HINT} />
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
