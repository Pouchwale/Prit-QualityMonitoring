import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Camera, Hash, Pencil, Plus, Search, Trash2, Video, X } from 'lucide-react'
import type { Activity, AppliesWhen, Department, Machine, Parameter, ParameterType } from '../../types'
import { api, errorText } from '../../lib/api'
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

interface FormParameter {
  parameterId: string
  isRequired: boolean
  isEnabled: boolean
  /** Per-parameter evidence: the worker captures it on that parameter's card. */
  requirePhoto: boolean
  requireVideo: boolean
  allowNa: boolean
  appliesWhen: AppliesWhen
}

interface ActivityForm {
  name: string
  code: string
  departmentId: string
  description: string
  isActive: boolean
  requireJobNo: boolean
  requirePhoto: boolean
  requireVideo: boolean
  allowManual: boolean
  /** Array order = order on the worker form. */
  parameters: FormParameter[]
  machineIds: string[]
}

/** Request body for POST / PUT /api/activities. */
interface ActivityBody {
  name: string
  code: string
  departmentId: string | null
  description: string | null
  requirePhoto: boolean
  requireVideo: boolean
  requireJobNo: boolean
  allowManual: boolean
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
  departmentId: '',
  description: '',
  isActive: true,
  requireJobNo: true,
  requirePhoto: true,
  requireVideo: false,
  allowManual: true,
  parameters: [],
  machineIds: []
}

const formFromActivity = (a: Activity): ActivityForm => ({
  name: a.name,
  code: a.code,
  departmentId: a.departmentId ?? '',
  description: a.description ?? '',
  isActive: a.isActive,
  requireJobNo: a.requireJobNo,
  requirePhoto: a.requirePhoto,
  requireVideo: a.requireVideo,
  allowManual: a.allowManual,
  parameters: a.parameters.map((p) => ({
    parameterId: p.parameterId,
    isRequired: p.isRequired,
    isEnabled: p.isEnabled,
    requirePhoto: p.requirePhoto,
    requireVideo: p.requireVideo,
    allowNa: p.allowNa,
    appliesWhen: p.appliesWhen
  })),
  machineIds: [...a.machineIds]
})

const EvidenceBadge: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-due-line bg-due-bg text-due text-[11px] lg:text-[10px] font-medium whitespace-nowrap">
    {icon}
    {label}
  </span>
)

const Section: React.FC<{ step: number; title: string; description?: string; children: React.ReactNode }> = ({
  step,
  title,
  description,
  children
}) => (
  <section className="space-y-2.5">
    <div className="flex items-baseline gap-2 border-b border-line pb-1.5">
      <span className="font-mono text-[11px] text-ink-faint">{step}.</span>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">{title}</h4>
      {description && <span className="text-[11px] text-ink-muted truncate">{description}</span>}
    </div>
    {children}
  </section>
)

const iconButton =
  'p-1 rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed'

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

  const activities = useMemo(() => data ?? [], [data])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return activities
    return activities.filter((a) => [a.name, a.code, a.departmentName ?? '', a.description ?? ''].some((s) => s.toLowerCase().includes(q)))
  }, [activities, search])

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

  const availableParameters = (allParameters ?? []).filter((p) => !form.parameters.some((fp) => fp.parameterId === p.id))

  const addParameter = () => {
    const parameter = availableParameters.find((p) => p.id === addParameterId)
    if (!parameter) return
    update('parameters', [
      ...form.parameters,
      { parameterId: parameter.id, isRequired: parameter.isRequired, isEnabled: true, requirePhoto: false, requireVideo: false, allowNa: false, appliesWhen: 'ALWAYS' }
    ])
    setAddParameterId('')
  }

  // ----- save / delete -----
  const submit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const body: ActivityBody = {
      name: form.name.trim(),
      code: form.code.trim(),
      departmentId: form.departmentId || null,
      description: form.description.trim() || null,
      requirePhoto: form.requirePhoto,
      requireVideo: form.requireVideo,
      requireJobNo: form.requireJobNo,
      allowManual: form.allowManual,
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
    <div className="space-y-4">
      <PageHeader
        title="Check Types"
        description="What workers fill in for each quality check: parameters, evidence and machines. Changes apply to the worker app immediately."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Check Type
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search name, code or department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="ml-auto text-ink-muted">
          {activities.filter((a) => a.isActive).length} active · {activities.length} total
        </div>
      </div>

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        empty={data === null ? undefined : visible.length === 0}
        emptyText={activities.length === 0 ? 'No check types yet. Add the first one.' : 'No check types match the search.'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3">Check type</th>
                <th className="py-2.5 px-3">Department</th>
                <th className="py-2.5 px-3">Parameters</th>
                <th className="py-2.5 px-3">Evidence</th>
                <th className="py-2.5 px-3">Machines</th>
                <th className="py-2.5 px-3">Status</th>
                {canEdit && <th className="py-2.5 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((a) => {
                const shown = a.parameters.filter((p) => p.isEnabled && p.parameterActive)
                const machineNames = a.machineIds.map((id) => machineById.get(id)?.name).filter(Boolean)
                const hasEvidence = a.requireJobNo || a.requirePhoto || a.requireVideo
                return (
                  <tr key={a.id} className="hover:bg-slate-50 transition-colors align-top">
                    <td className="py-2.5 px-3">
                      <span className={`font-semibold ${a.isActive ? 'text-ink' : 'text-ink-muted'}`}>{a.name}</span>
                      <span className="block font-mono text-[11px] text-ink-secondary">{a.code}</span>
                      {a.description && <span className="block text-[11px] text-ink-muted truncate max-w-xs">{a.description}</span>}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap text-slate-700">{a.departmentName ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3">
                      <span className="font-medium text-ink">{shown.length} on form</span>
                      {shown.length !== a.parameters.length && (
                        <span className="text-ink-muted"> · {a.parameters.length - shown.length} off</span>
                      )}
                      {shown.length > 0 && (
                        <span className="block text-[11px] text-ink-muted max-w-xs truncate" title={shown.map((p) => p.name).join(', ')}>
                          {shown.map((p) => p.name).join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {hasEvidence ? (
                        <div className="flex flex-wrap gap-1 max-w-[200px]">
                          {a.requireJobNo && <EvidenceBadge icon={<Hash className="w-3 h-3" />} label="Job No." />}
                          {a.requirePhoto && <EvidenceBadge icon={<Camera className="w-3 h-3" />} label="Photo" />}
                          {a.requireVideo && <EvidenceBadge icon={<Video className="w-3 h-3" />} label="Video" />}
                        </div>
                      ) : (
                        <span className="text-ink-faint">None required</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      {a.machineIds.length ? (
                        <span className="text-ink" title={machineNames.join(', ')}>
                          {a.machineIds.length} machine{a.machineIds.length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-ink-faint">No machines</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <StatusBadge status={a.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                    </td>
                    {canEdit && (
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => openEdit(a)} icon={<Pencil className="w-3 h-3" />}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleting(a)}
                            icon={<Trash2 className="w-3 h-3 text-failed" />}
                            title="Delete check type"
                            aria-label={`Delete ${a.name}`}
                          />
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
        <form onSubmit={submit} className="space-y-5">
          <FormError message={formError} />

          <Section step={1} title="Details">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Name" required className="sm:col-span-2">
                <TextInput value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Printing Hourly Check" autoFocus />
              </Field>
              <Field label="Code" required>
                <TextInput value={form.code} onChange={(e) => update('code', e.target.value)} placeholder="e.g. PRT-HOURLY" className="font-mono" />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Department">
                <Select value={form.departmentId} onChange={(e) => update('departmentId', e.target.value)}>
                  <option value="">No department</option>
                  {departmentOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2 flex items-end pb-1.5">
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

          <Section step={2} title="Worker form requirements" description="What the worker must provide before submitting">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Toggle
                checked={form.requireJobNo}
                onChange={(v) => update('requireJobNo', v)}
                label="Job No. required"
                description="Worker enters the job number."
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
            <p className="text-[11px] text-ink-muted">
              Prefer per-parameter evidence: set Photo and Video on the parameters below so the worker captures each reading. The overall photo and video
              are captured once at the end of the form.
            </p>
            <Toggle
              checked={form.allowManual}
              onChange={(v) => update('allowManual', v)}
              label="Allow manual submission"
              description="Workers can start this check from the machine at any time, without waiting for a notification."
            />
          </Section>

          <Section step={3} title="Parameters on this form" description="Workers see them in this order">
            <div className="border border-line-strong rounded divide-y divide-line bg-white">
              {form.parameters.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-ink-muted">No parameters yet. Add them below.</div>
              ) : (
                form.parameters.map((fp, index) => {
                  const info = parameterInfo.get(fp.parameterId)
                  return (
                    <div
                      key={fp.parameterId}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-1.5 ${fp.isEnabled ? '' : 'bg-slate-50'}`}
                    >
                      <div className="flex items-center gap-0.5">
                        <span className="w-5 text-right font-mono text-[11px] text-ink-faint">{index + 1}</span>
                        <button type="button" title="Move up" className={iconButton} disabled={index === 0} onClick={() => moveParameter(index, -1)}>
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Move down"
                          className={iconButton}
                          disabled={index === form.parameters.length - 1}
                          onClick={() => moveParameter(index, 1)}
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="flex-1 min-w-[160px]">
                        <span className={`text-xs font-medium ${fp.isEnabled ? 'text-ink' : 'text-ink-muted'}`}>{info?.name ?? 'Unknown parameter'}</span>
                        <span className="ml-1.5 text-[11px] text-ink-muted">
                          {info ? PARAMETER_TYPE_LABEL[info.type] : ''}
                          {info?.unit ? ` · ${info.unit}` : ''}
                        </span>
                        {info && !info.isActive && (
                          <span className="ml-1.5 px-1 py-px rounded border border-exception-line bg-exception-bg text-exception text-[11px] lg:text-[10px] font-medium">
                            Disabled globally
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <Toggle checked={fp.isEnabled} onChange={(v) => updateParameter(index, { isEnabled: v })} label="Enabled" />
                        <button
                          type="button"
                          title="Remove from this check type"
                          className={`${iconButton} hover:text-failed`}
                          onClick={() => removeParameter(index)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Per-parameter rules: what the worker must provide for this reading. */}
                      <div className="basis-full flex flex-wrap items-center gap-x-4 gap-y-1 pl-[26px]">
                        <Toggle checked={fp.isRequired} onChange={(v) => updateParameter(index, { isRequired: v })} label="Required" />
                        <Toggle checked={fp.requirePhoto} onChange={(v) => updateParameter(index, { requirePhoto: v })} label="Photo" />
                        <Toggle checked={fp.requireVideo} onChange={(v) => updateParameter(index, { requireVideo: v })} label="Video" />
                        <Toggle checked={fp.allowNa} onChange={(v) => updateParameter(index, { allowNa: v })} label="Allow N/A" />
                        <Toggle
                          checked={fp.appliesWhen === 'JOB_RUNNING'}
                          onChange={(v) => updateParameter(index, { appliesWhen: v ? 'JOB_RUNNING' : 'ALWAYS' })}
                          label="Only while a job is running"
                        />
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="flex items-center gap-2">
              <Select value={addParameterId} onChange={(e) => setAddParameterId(e.target.value)} className="flex-1">
                <option value="">
                  {allParameters === null
                    ? 'Loading parameters…'
                    : availableParameters.length
                      ? 'Choose a parameter to add…'
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
            <p className="text-[11px] text-ink-muted">
              {enabledOnForm} of {form.parameters.length} enabled. Turn a parameter off to hide it from this form without losing its settings. Photo and
              Video are captured on that parameter's own card; Allow N/A lets the worker record a reason instead of a value, which never counts as a
              failure.
            </p>
          </Section>

          <Section step={4} title="Machines" description="Which machines use this check type">
            <MultiSelectList
              items={machineItems}
              selected={form.machineIds}
              onChange={(ids) => update('machineIds', ids)}
              emptyText={machines === null ? 'Loading machines…' : 'No machines configured yet'}
            />
            <p className="text-[11px] text-ink-muted">{form.machineIds.length} selected</p>
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
