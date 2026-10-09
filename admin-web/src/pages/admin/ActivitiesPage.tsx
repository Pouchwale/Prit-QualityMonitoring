import React, { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Camera,
  CircleSlash,
  ClipboardList,
  Clock3,
  Cpu,
  FileText,
  Hash,
  Info,
  ListChecks,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Video,
  X
} from 'lucide-react'
import type { Activity, AppliesWhen, Department, Machine, Parameter, ParameterFrequency, ParameterType, QualityModule } from '../../types'
import { api, errorText } from '../../lib/api'
import { NotificationDevicesSection } from './NotificationDevicesSection'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { PARAMETER_TYPE_LABEL } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { Modal } from '../../components/common/Modal'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Field, FormError, MultiSelectList, Select, TextArea, TextInput, Toggle, inputClass } from '../../components/common/Form'
import { Card, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { ReasonsSection } from './ReasonsSection'

interface FormParameter {
  parameterId: string
  isRequired: boolean
  isEnabled: boolean
  /** Per-parameter evidence: the worker captures it on that parameter's card. */
  requirePhoto: boolean
  requireVideo: boolean
  allowNa: boolean
  appliesWhen: AppliesWhen
  /** Job-based check types: checked at job start, every intervalMinutes, or at job end. */
  frequency: ParameterFrequency
  intervalMinutes: number
}

/** The "When checked" choices of a job-based check type's parameter. */
const FREQUENCY_CHOICES = [
  { value: 'JOB_START', label: 'Job start' },
  { value: '60', label: 'Every 1 hour' },
  { value: '120', label: 'Every 2 hours' },
  { value: '180', label: 'Every 3 hours' },
  { value: 'CUSTOM', label: 'Custom interval' },
  { value: 'JOB_END', label: 'Job end' }
] as const

const frequencyChoice = (p: FormParameter) =>
  p.frequency !== 'INTERVAL' ? p.frequency : ([60, 120, 180].includes(p.intervalMinutes) ? (String(p.intervalMinutes) as '60' | '120' | '180') : 'CUSTOM')

interface ActivityForm {
  name: string
  code: string
  module: QualityModule
  departmentId: string
  description: string
  isActive: boolean
  requireJobNo: boolean
  requirePhoto: boolean
  requireVideo: boolean
  allowManual: boolean
  /** SHIFT: checks from shift schedules. JOB: per job, each parameter at its own frequency. */
  monitoring: 'SHIFT' | 'JOB'
  graceMinutes: string
  /** Array order = order on the worker form. */
  parameters: FormParameter[]
  machineIds: string[]
}

/** Request body for POST / PUT /api/activities. */
interface ActivityBody {
  name: string
  code: string
  module: QualityModule
  departmentId: string | null
  description: string | null
  requirePhoto: boolean
  requireVideo: boolean
  requireJobNo: boolean
  allowManual: boolean
  monitoring: 'SHIFT' | 'JOB'
  graceMinutes: number
  isActive: boolean
  parameters: FormParameter[]
  machineIds: string[]
}

/** Display info for a parameter row in the form. */
interface ParameterInfo {
  name: string
  code: string
  type: ParameterType
  unit: string | null
  isActive: boolean
}

const emptyForm: ActivityForm = {
  name: '',
  code: '',
  module: 'IPQC',
  departmentId: '',
  description: '',
  isActive: true,
  requireJobNo: true,
  requirePhoto: true,
  requireVideo: false,
  allowManual: true,
  monitoring: 'SHIFT',
  graceMinutes: '20',
  parameters: [],
  machineIds: []
}

const formFromActivity = (a: Activity): ActivityForm => ({
  name: a.name,
  code: a.code,
  module: a.module ?? 'IPQC',
  departmentId: a.departmentId ?? '',
  description: a.description ?? '',
  isActive: a.isActive,
  requireJobNo: a.requireJobNo,
  requirePhoto: a.requirePhoto,
  requireVideo: a.requireVideo,
  allowManual: a.allowManual,
  monitoring: a.monitoring ?? 'SHIFT',
  graceMinutes: String(a.graceMinutes ?? 20),
  parameters: a.parameters.map((p) => ({
    parameterId: p.parameterId,
    isRequired: p.isRequired,
    isEnabled: p.isEnabled,
    requirePhoto: p.requirePhoto,
    requireVideo: p.requireVideo,
    allowNa: p.allowNa,
    appliesWhen: p.appliesWhen,
    frequency: p.frequency ?? 'INTERVAL',
    intervalMinutes: p.intervalMinutes ?? 60
  })),
  machineIds: [...a.machineIds]
})

/** A small neutral chip, e.g. a check type code. */
const chip = 'inline-flex items-center h-5 px-1.5 rounded bg-subtle ring-1 ring-inset ring-line text-[11px] text-ink-secondary whitespace-nowrap'

/** IPQC (in-process) or QC (finished goods): the label says which, the tint only groups them. */
const ModulePill: React.FC<{ module: QualityModule }> = ({ module }) => (
  <span
    className={`inline-flex items-center h-5 px-2 rounded-full text-[11px] font-semibold tracking-wide ring-1 ring-inset whitespace-nowrap ${
      module === 'QC' ? 'bg-white text-ink ring-line-strong' : 'bg-accent-soft text-accent-strong ring-accent-line'
    }`}
    title={module === 'QC' ? 'QC (Finished / Pouch Quality)' : 'IPQC (In-Process Quality)'}
  >
    {module}
  </span>
)

/** How checks are created: from shift schedules or per job. */
const ModePill: React.FC<{ mode: 'SHIFT' | 'JOB' }> = ({ mode }) => (
  <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-subtle text-ink-secondary ring-1 ring-inset ring-line text-[11px] font-medium whitespace-nowrap">
    {mode === 'JOB' ? <Briefcase className="w-3 h-3" aria-hidden /> : <Clock3 className="w-3 h-3" aria-hidden />}
    {mode === 'JOB' ? 'Job' : 'Shift'}
  </span>
)

/** One required evidence item as an icon tile; the name is its tooltip and accessible text. */
const EvidenceIcon: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <span className="w-6 h-6 inline-flex items-center justify-center rounded-md bg-due-bg text-due ring-1 ring-inset ring-due-line" title={label}>
    <span aria-hidden>{icon}</span>
    <span className="sr-only">{label}</span>
  </span>
)

/** One step of the check type form: a numbered heading, a short line and the fields. */
const Section: React.FC<{ step: number; title: string; description?: string; icon?: React.ReactNode; children: React.ReactNode }> = ({
  step,
  title,
  description,
  icon,
  children
}) => (
  <section className="rounded-lg border border-line bg-white" aria-labelledby={`check-type-step-${step}`}>
    <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line bg-subtle/50 rounded-t-lg">
      <span
        className="w-6 h-6 shrink-0 rounded-full bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent-line text-[11.5px] font-semibold tabular-nums flex items-center justify-center"
        aria-hidden
      >
        {step}
      </span>
      <div className="min-w-0 flex-1">
        <h4 id={`check-type-step-${step}`} className="text-[13px] font-semibold text-ink leading-tight">
          <span className="sr-only">Step {step}: </span>
          {title}
        </h4>
        {description && <p className="text-[11.5px] text-ink-muted leading-snug">{description}</p>}
      </div>
      {icon && (
        <span className="text-ink-faint shrink-0" aria-hidden>
          {icon}
        </span>
      )}
    </div>
    <div className="p-3.5 space-y-3">{children}</div>
  </section>
)

/** A short explanation under a group of fields. */
const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="flex items-start gap-1.5 text-[11.5px] text-ink-muted leading-snug">
    <Info className="w-3.5 h-3.5 mt-px shrink-0 text-ink-faint" aria-hidden />
    <span>{children}</span>
  </p>
)

const iconButton =
  'w-9 h-9 lg:w-6 lg:h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed'

export const ActivitiesPage: React.FC = () => {
  const canEdit = useCanManage('activities')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<Activity[]>('/api/activities')
  const { data: allParameters } = useApi<Parameter[]>('/api/parameters')
  const { data: machines } = useApi<Machine[]>('/api/machines')
  const { data: departments } = useApi<Department[]>('/api/departments')

  const [search, setSearch] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Activity | null>(null)
  const [form, setForm] = useState<ActivityForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addParameterId, setAddParameterId] = useState('')

  const [deleting, setDeleting] = useState<Activity | null>(null)
  const [moduleFilter, setModuleFilter] = useState<'ALL' | 'IPQC' | 'QC'>('ALL')

  const activities = useMemo(() => data ?? [], [data])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return activities.filter((a) => {
      if (moduleFilter !== 'ALL' && a.module !== moduleFilter) return false
      if (!q) return true
      return [a.name, a.code, a.departmentName ?? '', a.description ?? '', a.module].some((s) => s.toLowerCase().includes(q))
    })
  }, [activities, search, moduleFilter])
  const page = usePagination(visible, 25, `${search}|${moduleFilter}`)
  const activeCount = activities.filter((a) => a.isActive).length
  const moduleCount = (m: QualityModule) => activities.filter((a) => (a.module ?? 'IPQC') === m).length

  const machineById = useMemo(() => new Map((machines ?? []).map((m) => [m.id, m])), [machines])

  /** Parameter details from the global list, falling back to what the activity returned. */
  const parameterInfo = useMemo(() => {
    const map = new Map<string, ParameterInfo>()
    for (const a of activities) {
      for (const p of a.parameters) {
        map.set(p.parameterId, { name: p.name, code: p.code, type: p.type, unit: p.unit, isActive: p.parameterActive })
      }
    }
    for (const p of allParameters ?? []) {
      map.set(p.id, { name: p.name, code: p.code, type: p.type, unit: p.unit, isActive: p.isActive })
    }
    return map
  }, [activities, allParameters])

  const update = <K extends keyof ActivityForm>(key: K, value: ActivityForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const openAdd = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormError(null)
    setAddParameterId('')
    setFormOpen(true)
  }

  const openEdit = (a: Activity) => {
    setEditing(a)
    setForm(formFromActivity(a))
    setFormError(null)
    setAddParameterId('')
    setFormOpen(true)
  }

  const closeForm = () => {
    if (!saving) setFormOpen(false)
  }

  // ----- parameter list editing -----
  const updateParameter = (index: number, patch: Partial<FormParameter>) =>
    update(
      'parameters',
      form.parameters.map((p, i) => (i === index ? { ...p, ...patch } : p))
    )

  const moveParameter = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= form.parameters.length) return
    const next = [...form.parameters]
    ;[next[index], next[target]] = [next[target], next[index]]
    update('parameters', next)
  }

  const removeParameter = (index: number) =>
    update(
      'parameters',
      form.parameters.filter((_, i) => i !== index)
    )

  /**
   * A check type may only use the parameters of its own department. A parameter with no department
   * is unassigned and fits every check type; a check type with no department can use anything.
   */
  const forThisDepartment = (p: Parameter) => !form.departmentId || p.departmentIds.length === 0 || p.departmentIds.includes(form.departmentId)
  const unused = (allParameters ?? []).filter((p) => !form.parameters.some((fp) => fp.parameterId === p.id))
  const availableParameters = unused.filter(forThisDepartment)
  const hiddenByDepartment = unused.length - availableParameters.length

  const addParameter = () => {
    const parameter = availableParameters.find((p) => p.id === addParameterId)
    if (!parameter) return
    update('parameters', [
      ...form.parameters,
      {
        parameterId: parameter.id,
        isRequired: parameter.isRequired,
        isEnabled: true,
        requirePhoto: false,
        requireVideo: false,
        allowNa: false,
        appliesWhen: 'ALWAYS',
        frequency: 'INTERVAL',
        intervalMinutes: 60
      }
    ])
    setAddParameterId('')
  }

  // ----- save / delete -----
  const submit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const grace = Number(form.graceMinutes)
    if (form.monitoring === 'JOB') {
      if (!Number.isInteger(grace) || grace < 5 || grace > 240) return setFormError('Grace must be 5 to 240 minutes')
      const bad = form.parameters.find((p) => p.frequency === 'INTERVAL' && (!Number.isInteger(p.intervalMinutes) || p.intervalMinutes < 5 || p.intervalMinutes > 1440))
      if (bad) return setFormError(`${parameterInfo.get(bad.parameterId)?.name ?? 'A parameter'}: the interval must be 5 to 1440 minutes`)
    }
    const body: ActivityBody = {
      name: form.name.trim(),
      code: form.code.trim(),
      module: form.module ?? 'IPQC',
      departmentId: form.departmentId || null,
      description: form.description.trim() || null,
      requirePhoto: form.requirePhoto,
      requireVideo: form.requireVideo,
      requireJobNo: form.requireJobNo,
      allowManual: form.allowManual,
      monitoring: form.monitoring,
      graceMinutes: Number.isInteger(grace) && grace >= 5 ? grace : 20,
      isActive: form.isActive,
      parameters: form.parameters,
      machineIds: form.machineIds
    }

    setSaving(true)
    setFormError(null)
    try {
      if (editing) await api.put(`/api/activities/${editing.id}`, body)
      else await api.post('/api/activities', body)
      notify('success', editing ? 'Check type updated' : 'Check type created', `${body.name} — changes apply to the worker app now.`)
      setFormOpen(false)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      const { result } = await api.del(`/api/activities/${deleting.id}`)
      if (result === 'disabled') {
        notify('warning', 'Check type disabled', `${deleting.name} already has quality checks or schedules, so it was disabled instead of deleted to keep history.`)
      } else {
        notify('success', 'Check type deleted', deleting.name)
      }
      reload()
    } catch (err) {
      notify('error', 'Could not delete check type', errorText(err))
    }
  }

  const departmentOptions = (departments ?? []).filter((d) => d.isActive || d.id === form.departmentId)
  const machineItems = (machines ?? [])
    .filter((m) => m.isActive || form.machineIds.includes(m.id))
    .map((m) => ({ id: m.id, label: m.isActive ? m.name : `${m.name} (inactive)`, detail: m.code }))

  const enabledOnForm = form.parameters.filter((p) => p.isEnabled).length

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="w-4.5 h-4.5" />}
        title="Check Types"
        description={data ? `${activeCount} active · ${activities.length} total` : 'Parameters, evidence and machines per check'}
        info="What workers fill in for each quality check: parameters, evidence and machines. Changes apply to the worker app immediately."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Check Type
            </Button>
          )
        }
      />

      {/* Module Notification Devices Configuration Section */}
      <NotificationDevicesSection />

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        empty={data === null ? undefined : activities.length === 0}
        emptyText="No check types yet. Add the first one."
      >
        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search check types" placeholder="Search check types…" />
            <Segmented
              label="Filter by module"
              value={moduleFilter}
              onChange={setModuleFilter}
              options={[
                { value: 'ALL', label: 'All Modules', count: activities.length },
                { value: 'IPQC', label: 'IPQC', count: moduleCount('IPQC') },
                { value: 'QC', label: 'QC', count: moduleCount('QC') }
              ]}
            />
            <ToolbarSpacer />
            <ResultCount shown={visible.length} total={activities.length} noun="check types" />
          </Toolbar>

          {visible.length === 0 ? (
            <EmptyState icon={<Search className="w-5 h-5" />} title="No check types match the search." compact />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Check type</th>
                    <th>Module</th>
                    <th>Mode</th>
                    <th>Department</th>
                    <th>Parameters</th>
                    <th>Evidence</th>
                    <th className="num">Machines</th>
                    <th>Status</th>
                    {canEdit && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {page.visible.map((a) => {
                    const shown = a.parameters.filter((p) => p.isEnabled && p.parameterActive)
                    const machineNames = a.machineIds.map((id) => machineById.get(id)?.name).filter(Boolean)
                    const hasEvidence = a.requireJobNo || a.requirePhoto || a.requireVideo
                    return (
                      <tr key={a.id}>
                        <td>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-semibold ${a.isActive ? 'text-ink' : 'text-ink-muted'}`}>{a.name}</span>
                            <span className={`${chip} font-mono`} title="Code">
                              {a.code}
                            </span>
                          </div>
                          {a.description && <span className="block text-[11.5px] text-ink-muted truncate max-w-xs">{a.description}</span>}
                        </td>
                        <td>
                          <ModulePill module={a.module ?? 'IPQC'} />
                        </td>
                        <td>
                          <ModePill mode={a.monitoring ?? 'SHIFT'} />
                        </td>
                        <td className="whitespace-nowrap text-ink-secondary">{a.departmentName ?? <span className="text-ink-faint">—</span>}</td>
                        <td>
                          <span className="whitespace-nowrap">
                            <span className="font-semibold text-ink tabular-nums">{shown.length}</span> <span className="text-ink-secondary">on form</span>
                            {shown.length !== a.parameters.length && (
                              <span className="text-ink-muted tabular-nums"> · {a.parameters.length - shown.length} off</span>
                            )}
                          </span>
                          {shown.length > 0 && (
                            <span className="block text-[11.5px] text-ink-muted max-w-[220px] truncate" title={shown.map((p) => p.name).join(', ')}>
                              {shown.map((p) => p.name).join(', ')}
                            </span>
                          )}
                        </td>
                        <td>
                          {hasEvidence ? (
                            <div className="flex items-center gap-1">
                              {a.requireJobNo && <EvidenceIcon icon={<Hash className="w-3.5 h-3.5" />} label="PO No. required" />}
                              {a.requirePhoto && <EvidenceIcon icon={<Camera className="w-3.5 h-3.5" />} label="Overall photo required" />}
                              {a.requireVideo && <EvidenceIcon icon={<Video className="w-3.5 h-3.5" />} label="Overall video required" />}
                            </div>
                          ) : (
                            <span className="text-[12px] text-ink-muted">None required</span>
                          )}
                        </td>
                        <td className="num whitespace-nowrap">
                          {a.machineIds.length ? (
                            <span className="text-ink" title={machineNames.join(', ')}>
                              {a.machineIds.length} <span className="text-ink-muted">machine{a.machineIds.length === 1 ? '' : 's'}</span>
                            </span>
                          ) : (
                            <span className="text-ink-faint">No machines</span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={a.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                        </td>
                        {canEdit && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex items-center gap-0.5">
                              <IconButton label={`Edit ${a.name}`} onClick={() => openEdit(a)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </IconButton>
                              <IconButton label={`Delete ${a.name}`} tone="danger" onClick={() => setDeleting(a)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </IconButton>
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
          <Pagination page={page.page} pages={page.pages} total={page.total} pageSize={page.pageSize} onPage={page.setPage} noun="check types" />
        </Card>
      </DataState>

      {/* What a worker may pick when a parameter cannot be read, or a whole check cannot be done. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <ReasonsSection
          title="N/A reasons"
          icon={<CircleSlash className="w-4 h-4" />}
          description="Why a parameter could not be read. A check with Not Applicable parameters still counts as Completed, never as a failure."
          endpoint="/api/monitoring-reasons"
          noun="N/A Reason"
          dialogSubtitle="Workers choose one of these when a parameter cannot be read"
          placeholder="e.g. No production"
        />

        <ReasonsSection
          title="Exception reasons"
          icon={<ShieldAlert className="w-4 h-4" />}
          description="Why a whole check could not be done. The worker raises an exception with one of these, and the check is recorded as an Exception for review."
          endpoint="/api/exception-reasons"
          noun="Exception Reason"
          dialogSubtitle="Workers choose one of these when a check cannot be done at all"
          placeholder="e.g. Power cut"
        />
      </div>

      {/* Create / edit */}
      <Modal
        isOpen={formOpen}
        onClose={closeForm}
        title={editing ? 'Edit Check Type' : 'Add Check Type'}
        subtitle="Saved changes apply to the worker app immediately"
        maxWidth="2xl"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => submit()} loading={saving}>
              {editing ? 'Save Changes' : 'Create Check Type'}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} className="space-y-4">
          <FormError message={formError} />

          <Section step={1} title="Details" description="Name, module and department" icon={<FileText className="w-4 h-4" />}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Name" required className="sm:col-span-2">
                <TextInput value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Printing Hourly Check" autoFocus />
              </Field>
              <Field label="Code" required>
                <TextInput value={form.code} onChange={(e) => update('code', e.target.value)} placeholder="e.g. PRT-HOURLY" className="font-mono" />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Quality Module" required hint="IPQC or QC determines which dedicated phone receives due alerts">
                <Select value={form.module} onChange={(e) => update('module', e.target.value as QualityModule)}>
                  <option value="IPQC">IPQC (In-Process Quality)</option>
                  <option value="QC">QC (Finished / Pouch Quality)</option>
                </Select>
              </Field>
              <Field label="Department" hint="Only this department's jobs get this check (a job's Item Code decides its department). No department: every job.">
                <Select value={form.departmentId} onChange={(e) => update('departmentId', e.target.value)}>
                  <option value="">No department</option>
                  {departmentOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end pb-1.5">
                <Toggle
                  checked={form.isActive}
                  onChange={(v) => update('isActive', v)}
                  label="Active"
                  description="Inactive check types are not scheduled and upcoming checks are removed."
                />
              </div>
            </div>
            <Field label="Description">
              <TextArea
                rows={2}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
                placeholder="When this check is done and any SOP reference…"
              />
            </Field>
          </Section>

          <Section step={2} title="Worker form requirements" description="What the worker must provide before submitting" icon={<ShieldCheck className="w-4 h-4" />}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Toggle
                checked={form.requireJobNo}
                onChange={(v) => update('requireJobNo', v)}
                label="PO No. required"
                description="Worker enters the PO number."
              />
              <Toggle
                checked={form.requirePhoto}
                onChange={(v) => update('requirePhoto', v)}
                label="Overall check photo"
                description="One extra live photo for the whole check."
              />
              <Toggle
                checked={form.requireVideo}
                onChange={(v) => update('requireVideo', v)}
                label="Overall check video"
                description="One extra video (up to 60 seconds) for the whole check."
              />
            </div>
            <Hint>
              Prefer per-parameter evidence: set Photo and Video on the parameters below so the worker captures each reading. The overall photo and video
              are captured once at the end of the form.
            </Hint>
            <Toggle
              checked={form.allowManual}
              onChange={(v) => update('allowManual', v)}
              label="Allow manual submission"
              description="Workers can start this check from the machine at any time, without waiting for a notification."
            />
          </Section>

          <Section step={3} title="When it is checked" description="Shift schedules, or per job with a frequency per parameter" icon={<Clock3 className="w-4 h-4" />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(
                [
                  { value: 'SHIFT', label: 'Shift schedules', hint: 'Every parameter at each scheduled check (Schedules page).', icon: <Clock3 className="w-4 h-4" /> },
                  { value: 'JOB', label: 'Job-based', hint: 'Job start, every N hours and job end: only the parameters due are asked.', icon: <Briefcase className="w-4 h-4" /> }
                ] as const
              ).map((o) => (
                <label
                  key={o.value}
                  className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
                    form.monitoring === o.value ? 'border-accent bg-accent-soft ring-1 ring-accent-line' : 'border-line-strong hover:bg-subtle'
                  }`}
                >
                  <input type="radio" name="monitoring" className="mt-0.5 accent-accent" checked={form.monitoring === o.value} onChange={() => update('monitoring', o.value)} />
                  <span className={`mt-px shrink-0 ${form.monitoring === o.value ? 'text-accent' : 'text-ink-muted'}`} aria-hidden>
                    {o.icon}
                  </span>
                  <span>
                    <span className="block text-[12.5px] font-semibold text-ink">{o.label}</span>
                    <span className="block text-[11px] text-ink-muted">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {form.monitoring === 'JOB' && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Grace (minutes)" hint="A scheduled job check counts as Missed this long after it is due.">
                  <TextInput type="number" min={5} max={240} value={form.graceMinutes} onChange={(e) => update('graceMinutes', e.target.value)} className="w-28 font-mono" />
                </Field>
                <p className="text-[11.5px] text-ink-muted pb-2 max-w-md">
                  Set <span className="font-semibold">When checked</span> on each parameter below. The worker starts the job with the Job start parameters, gets
                  a notification when interval parameters are due (only those), and ends the job with the Job end parameters.
                </p>
              </div>
            )}
          </Section>

          <Section step={4} title="Parameters on this form" description="Workers see them in this order" icon={<ListChecks className="w-4 h-4" />}>
            <div className="border border-line rounded-md divide-y divide-line bg-white overflow-hidden">
              {form.parameters.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-ink-muted">No parameters yet. Add them below.</div>
              ) : (
                form.parameters.map((fp, index) => {
                  const info = parameterInfo.get(fp.parameterId)
                  return (
                    <div
                      key={fp.parameterId}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2 ${fp.isEnabled ? '' : 'bg-subtle/70'}`}
                    >
                      <div className="flex items-center gap-0.5">
                        <span className="w-5 text-right font-mono text-[11px] text-ink-faint">{index + 1}</span>
                        <button
                          type="button"
                          title="Move up"
                          aria-label={`Move ${info?.name ?? 'parameter'} up`}
                          className={iconButton}
                          disabled={index === 0}
                          onClick={() => moveParameter(index, -1)}
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Move down"
                          aria-label={`Move ${info?.name ?? 'parameter'} down`}
                          className={iconButton}
                          disabled={index === form.parameters.length - 1}
                          onClick={() => moveParameter(index, 1)}
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="flex-1 min-w-[160px]">
                        <span className={`text-[12.5px] font-medium ${fp.isEnabled ? 'text-ink' : 'text-ink-muted'}`}>{info?.name ?? 'Unknown parameter'}</span>
                        <span className="ml-1.5 text-[11px] text-ink-muted">
                          {info ? PARAMETER_TYPE_LABEL[info.type] : ''}
                          {info?.unit ? ` · ${info.unit}` : ''}
                        </span>
                        {info && !info.isActive && (
                          <span className="ml-1.5 px-1.5 py-px rounded-full ring-1 ring-inset ring-exception-line bg-exception-bg text-exception text-[11px] font-medium">
                            Disabled globally
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <Toggle checked={fp.isEnabled} onChange={(v) => updateParameter(index, { isEnabled: v })} label="Enabled" />
                        <button
                          type="button"
                          title="Remove from this check type"
                          aria-label={`Remove ${info?.name ?? 'parameter'} from this check type`}
                          className={`${iconButton} hover:!text-missed hover:!bg-missed-bg`}
                          onClick={() => removeParameter(index)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Per-parameter rules: what the worker must provide for this reading. */}
                      <div className="basis-full flex flex-wrap items-center gap-x-4 gap-y-1 ml-[26px] pl-2.5 border-l-2 border-line">
                        <Toggle checked={fp.isRequired} onChange={(v) => updateParameter(index, { isRequired: v })} label="Required" />
                        <Toggle checked={fp.requirePhoto} onChange={(v) => updateParameter(index, { requirePhoto: v })} label="Photo" />
                        <Toggle checked={fp.requireVideo} onChange={(v) => updateParameter(index, { requireVideo: v })} label="Video" />
                        <Toggle checked={fp.allowNa} onChange={(v) => updateParameter(index, { allowNa: v })} label="Allow N/A" />
                        {form.monitoring === 'SHIFT' && (
                          <Toggle
                            checked={fp.appliesWhen === 'JOB_RUNNING'}
                            onChange={(v) => updateParameter(index, { appliesWhen: v ? 'JOB_RUNNING' : 'ALWAYS' })}
                            label="Only while a job is running"
                          />
                        )}
                        {form.monitoring === 'JOB' && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-ink-secondary">When checked</span>
                            <select
                              aria-label={`When checked: ${info?.name ?? 'parameter'}`}
                              value={frequencyChoice(fp)}
                              onChange={(e) => {
                                const v = e.target.value
                                if (v === 'JOB_START' || v === 'JOB_END') updateParameter(index, { frequency: v })
                                else if (v === 'CUSTOM') updateParameter(index, { frequency: 'INTERVAL', intervalMinutes: fp.frequency === 'INTERVAL' && ![60, 120, 180].includes(fp.intervalMinutes) ? fp.intervalMinutes : 90 })
                                else updateParameter(index, { frequency: 'INTERVAL', intervalMinutes: Number(v) })
                              }}
                              className={`${inputClass} w-auto px-2`}
                            >
                              {FREQUENCY_CHOICES.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                            {frequencyChoice(fp) === 'CUSTOM' && (
                              <span className="inline-flex items-center gap-1">
                                <span className="text-[11px] text-ink-muted">every</span>
                                <input
                                  type="number"
                                  min={5}
                                  max={1440}
                                  aria-label={`Interval in minutes: ${info?.name ?? 'parameter'}`}
                                  value={fp.intervalMinutes}
                                  onChange={(e) => updateParameter(index, { intervalMinutes: Number(e.target.value) })}
                                  className="h-[40px] w-[96px] lg:h-8 lg:w-[84px] rounded-md border border-line-strong bg-white px-2 text-center font-mono text-[16px] lg:text-[13px] tabular-nums text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
                                />
                                <span className="text-[11px] text-ink-muted">min</span>
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="flex items-center gap-2">
              <Select value={addParameterId} onChange={(e) => setAddParameterId(e.target.value)} className="flex-1" aria-label="Parameter to add">
                <option value="">
                  {allParameters === null
                    ? 'Loading parameters…'
                    : availableParameters.length
                      ? 'Choose a parameter to add…'
                      : hiddenByDepartment
                        ? 'No parameter of this department is left to add'
                        : 'All parameters are already on this form'}
                </option>
                {availableParameters.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code}) · {PARAMETER_TYPE_LABEL[p.type]}
                    {p.isActive ? '' : ' · disabled'}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="outline" type="button" onClick={addParameter} disabled={!addParameterId} icon={<Plus className="w-3 h-3" />}>
                Add
              </Button>
            </div>
            <Hint>
              <span className="font-medium text-ink-secondary tabular-nums">
                {enabledOnForm} of {form.parameters.length} enabled.
              </span> Turn a parameter off to hide it from this form without losing its settings. Photo and
              Video are captured on that parameter's own card; Allow N/A lets the worker record a reason instead of a value, which never counts as a
              failure.
            </Hint>
            {hiddenByDepartment > 0 && (
              <Hint>
                {hiddenByDepartment} parameter{hiddenByDepartment === 1 ? ' is' : 's are'} not offered here because they belong to other departments.
                Add this department to a parameter in Parameters to make it available.
              </Hint>
            )}
          </Section>

          <Section step={5} title="Machines" description="Which machines use this check type" icon={<Cpu className="w-4 h-4" />}>
            <MultiSelectList
              items={machineItems}
              selected={form.machineIds}
              onChange={(ids) => update('machineIds', ids)}
              emptyText={machines === null ? 'Loading machines…' : 'No machines configured yet'}
            />
            <p className="text-[11.5px] text-ink-muted tabular-nums">{form.machineIds.length} selected</p>
          </Section>

          {/* Allows Enter to submit */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete check type?"
        danger
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
        message={
          deleting && (
            <div className="space-y-2">
              <p>
                <span className="font-semibold text-ink">{deleting.name}</span> will be deleted and its upcoming pending checks removed.
              </p>
              <p>If it already has recorded checks or schedules, it will be disabled instead so the history is kept.</p>
            </div>
          )
        }
      />
    </div>
  )
}
