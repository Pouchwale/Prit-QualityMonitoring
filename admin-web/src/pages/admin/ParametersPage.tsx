import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Power, Search, Trash2, X } from 'lucide-react'
import type { Department, Parameter, ParameterType } from '../../types'
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
import { Field, FormError, Select, TextArea, TextInput, Toggle, inputClass } from '../../components/common/Form'

const PARAMETER_TYPES: ParameterType[] = ['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL', 'PHOTO']

/** Request body for POST / PUT /api/parameters. */
interface ParameterBody {
  name: string
  code: string
  type: ParameterType
  unit: string | null
  minValue: number | null
  maxValue: number | null
  options: string[]
  isRequired: boolean
  isActive: boolean
  sortOrder: number
  description: string | null
  departmentId: string | null
}

interface ParameterForm {
  name: string
  code: string
  type: ParameterType
  unit: string
  minValue: string
  maxValue: string
  options: string[]
  isRequired: boolean
  isActive: boolean
  description: string
  departmentId: string
}

const emptyForm: ParameterForm = {
  name: '',
  code: '',
  type: 'NUMBER',
  unit: '',
  minValue: '',
  maxValue: '',
  options: [''],
  isRequired: true,
  isActive: true,
  description: '',
  departmentId: ''
}

const formFromParameter = (p: Parameter): ParameterForm => ({
  name: p.name,
  code: p.code,
  type: p.type,
  unit: p.unit ?? '',
  minValue: p.minValue === null ? '' : String(p.minValue),
  maxValue: p.maxValue === null ? '' : String(p.maxValue),
  options: p.options.length ? [...p.options] : [''],
  isRequired: p.isRequired,
  isActive: p.isActive,
  description: p.description ?? '',
  departmentId: p.departmentId ?? ''
})

/** Full body for an existing parameter, so partial updates (e.g. enable/disable) keep every other field. */
const bodyFromParameter = (p: Parameter): ParameterBody => ({
  name: p.name,
  code: p.code,
  type: p.type,
  unit: p.unit,
  minValue: p.minValue,
  maxValue: p.maxValue,
  options: p.options,
  isRequired: p.isRequired,
  isActive: p.isActive,
  sortOrder: p.sortOrder,
  description: p.description,
  departmentId: p.departmentId
})

const toNumberOrNull = (value: string) => (value.trim() === '' ? null : Number(value))

export const ParametersPage: React.FC = () => {
  const canEdit = useCanManage('parameters')
  const notify = useToast()
  const { data, error, loading, reload, setData } = useApi<Parameter[]>('/api/parameters')
  const { data: departments } = useApi<Department[]>('/api/departments')

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<ParameterType | 'ALL'>('ALL')
  const [showDisabled, setShowDisabled] = useState(true)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Parameter | null>(null)
  const [form, setForm] = useState<ParameterForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [deleting, setDeleting] = useState<Parameter | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)

  const parameters = useMemo(() => data ?? [], [data])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return parameters.filter((p) => {
      if (!showDisabled && !p.isActive) return false
      if (typeFilter !== 'ALL' && p.type !== typeFilter) return false
      if (!q) return true
      return [p.name, p.code, p.rule ?? '', p.description ?? ''].some((s) => s.toLowerCase().includes(q))
    })
  }, [parameters, search, typeFilter, showDisabled])

  const positionById = useMemo(() => new Map(parameters.map((p, index) => [p.id, index + 1])), [parameters])
  const activeCount = parameters.filter((p) => p.isActive).length

  const update = <K extends keyof ParameterForm>(key: K, value: ParameterForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const openAdd = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (p: Parameter) => {
    setEditing(p)
    setForm(formFromParameter(p))
    setFormError(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    if (!saving) setFormOpen(false)
  }

  const submit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const isNumber = form.type === 'NUMBER'
    const options = form.type === 'DROPDOWN' ? form.options.map((o) => o.trim()).filter(Boolean) : []
    const minValue = isNumber ? toNumberOrNull(form.minValue) : null
    const maxValue = isNumber ? toNumberOrNull(form.maxValue) : null

    if (form.type === 'DROPDOWN' && options.length === 0) return setFormError('Add at least one dropdown option')
    if ((minValue !== null && !Number.isFinite(minValue)) || (maxValue !== null && !Number.isFinite(maxValue))) {
      return setFormError('Minimum and maximum must be numbers')
    }

    const nextSortOrder = parameters.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1
    const body: ParameterBody = {
      name: form.name.trim(),
      code: form.code.trim(),
      type: form.type,
      unit: isNumber && form.unit.trim() ? form.unit.trim() : null,
      minValue,
      maxValue,
      options,
      isRequired: form.isRequired,
      isActive: form.isActive,
      sortOrder: editing ? editing.sortOrder : nextSortOrder,
      description: form.description.trim() || null,
      departmentId: form.departmentId || null
    }

    setSaving(true)
    setFormError(null)
    try {
      if (editing) await api.put(`/api/parameters/${editing.id}`, body)
      else await api.post('/api/parameters', body)
      notify('success', editing ? 'Parameter updated' : 'Parameter added', body.name)
      setFormOpen(false)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (p: Parameter) => {
    setBusyId(p.id)
    try {
      await api.put(`/api/parameters/${p.id}`, { ...bodyFromParameter(p), isActive: !p.isActive })
      notify('success', p.isActive ? 'Parameter disabled' : 'Parameter enabled', p.isActive ? `${p.name} is hidden from worker forms.` : `${p.name} is shown on worker forms again.`)
      reload()
    } catch (err) {
      notify('error', 'Could not update parameter', errorText(err))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await api.del(`/api/parameters/${deleting.id}`)
      notify('success', 'Parameter deleted', deleting.name)
      reload()
    } catch (err) {
      notify('error', 'Could not delete parameter', errorText(err))
    }
  }

  /** Moves a parameter past its neighbour in the visible list, then saves the full order. */
  const move = async (p: Parameter, direction: -1 | 1) => {
    const visibleIndex = visible.findIndex((v) => v.id === p.id)
    const neighbour = visible[visibleIndex + direction]
    if (!neighbour) return

    const rest = parameters.filter((x) => x.id !== p.id)
    const neighbourIndex = rest.findIndex((x) => x.id === neighbour.id)
    const next = [...rest]
    next.splice(direction === -1 ? neighbourIndex : neighbourIndex + 1, 0, p)

    setData(next.map((x, index) => ({ ...x, sortOrder: index })))
    setReordering(true)
    try {
      await api.put('/api/parameters/order', { ids: next.map((x) => x.id) })
    } catch (err) {
      notify('error', 'Could not save order', errorText(err))
    } finally {
      setReordering(false)
      reload()
    }
  }

  const departmentOptions = (departments ?? []).filter((d) => d.isActive || d.id === form.departmentId)
  const filtersActive = search.trim() !== '' || typeFilter !== 'ALL'

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quality Parameters"
        description="Fields workers fill in during a quality check. Add parameters here, then place them on check types."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Parameter
            </Button>
          )
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search name, code or rule…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Input type</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ParameterType | 'ALL')}
            className={`${inputClass} w-36 px-2`}
          >
            <option value="ALL">All types</option>
            {PARAMETER_TYPES.map((t) => (
              <option key={t} value={t}>
                {PARAMETER_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <Toggle checked={showDisabled} onChange={setShowDisabled} label="Show disabled" />
        <div className="ml-auto text-ink-muted">
          {activeCount} active · {parameters.length} total
        </div>
      </div>

      {canEdit && (
        <p className="text-[11px] text-ink-muted -mt-1">
          Arrows set the default display order. The order on each worker form is set per check type on the Check Types page.
          {filtersActive && ' Filters are on: a row moves past the next visible row.'}
        </p>
      )}

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        empty={data === null ? undefined : visible.length === 0}
        emptyText={parameters.length === 0 ? 'No parameters yet. Add the first one.' : 'No parameters match the filters.'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3 w-16">Order</th>
                <th className="py-2.5 px-3">Parameter</th>
                <th className="py-2.5 px-3">Code</th>
                <th className="py-2.5 px-3">Input type</th>
                <th className="py-2.5 px-3">Rule</th>
                <th className="py-2.5 px-3">Default</th>
                <th className="py-2.5 px-3 text-center">Used in</th>
                <th className="py-2.5 px-3">Status</th>
                {canEdit && <th className="py-2.5 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((p, index) => (
                <tr key={p.id} className={`hover:bg-slate-50 transition-colors ${p.isActive ? '' : 'bg-slate-50/60'}`}>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <span className="w-5 font-mono text-ink-muted text-right">{positionById.get(p.id)}</span>
                      {canEdit && (
                        <span className="flex flex-col">
                          <button
                            type="button"
                            title="Move up"
                            disabled={reordering || index === 0}
                            onClick={() => move(p, -1)}
                            className="w-[36px] h-[36px] lg:w-auto lg:h-auto flex items-center justify-center lg:p-0.5 rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            title="Move down"
                            disabled={reordering || index === visible.length - 1}
                            onClick={() => move(p, 1)}
                            className="w-[36px] h-[36px] lg:w-auto lg:h-auto flex items-center justify-center lg:p-0.5 rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-3">
                    <span className={`font-semibold ${p.isActive ? 'text-ink' : 'text-ink-muted'}`}>{p.name}</span>
                    {p.departmentName && <span className="ml-1.5 text-[11px] lg:text-[10px] text-ink-muted">· {p.departmentName}</span>}
                    {p.description && <span className="block text-[11px] text-ink-muted truncate max-w-xs">{p.description}</span>}
                  </td>
                  <td className="py-2 px-3 font-mono text-ink-secondary whitespace-nowrap">{p.code}</td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <span className="px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-accent text-[11px] lg:text-[10px] font-medium">
                      {PARAMETER_TYPE_LABEL[p.type]}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-mono text-ink max-w-xs">
                    {p.rule ? <span className="line-clamp-2">{p.rule}</span> : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    {p.isRequired ? (
                      <span className="text-ink font-medium">Required</span>
                    ) : (
                      <span className="text-ink-muted">Optional</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center whitespace-nowrap">
                    {p.activityIds.length ? (
                      <span className="text-ink">
                        {p.activityIds.length} check type{p.activityIds.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-ink-faint">Not used</span>
                    )}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <StatusBadge status={p.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                  </td>
                  {canEdit && (
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)} icon={<Pencil className="w-3 h-3" />}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleActive(p)}
                          loading={busyId === p.id}
                          icon={<Power className="w-3 h-3" />}
                          title={p.isActive ? 'Hide from worker forms' : 'Show on worker forms'}
                        >
                          {p.isActive ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleting(p)}
                          icon={<Trash2 className="w-3 h-3 text-failed" />}
                          title="Delete parameter"
                          aria-label={`Delete ${p.name}`}
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

      {/* Add / edit */}
      <Modal
        isOpen={formOpen}
        onClose={closeForm}
        title={editing ? 'Edit Parameter' : 'Add Parameter'}
        subtitle="What the worker enters and the limits used to pass or fail the value"
        maxWidth="xl"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => submit()} loading={saving}>
              {editing ? 'Save Changes' : 'Add Parameter'}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <FormError message={formError} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Parameter name" required>
              <TextInput value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Ink Viscosity" autoFocus />
            </Field>
            <Field label="Code" required>
              <TextInput
                value={form.code}
                onChange={(e) => update('code', e.target.value)}
                placeholder="e.g. VISCOSITY"
                className="font-mono"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Input type" required>
              <Select value={form.type} onChange={(e) => update('type', e.target.value as ParameterType)}>
                {PARAMETER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PARAMETER_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" hint="Optional. Helps group parameters.">
              <Select value={form.departmentId} onChange={(e) => update('departmentId', e.target.value)}>
                <option value="">All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {form.type === 'NUMBER' && (
            <div className="p-3 bg-slate-50 border border-line rounded space-y-2">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Unit">
                  <TextInput value={form.unit} onChange={(e) => update('unit', e.target.value)} placeholder="sec, mm, °C" />
                </Field>
                <Field label="Minimum">
                  <TextInput
                    type="number"
                    step="any"
                    value={form.minValue}
                    onChange={(e) => update('minValue', e.target.value)}
                    placeholder="No limit"
                  />
                </Field>
                <Field label="Maximum">
                  <TextInput
                    type="number"
                    step="any"
                    value={form.maxValue}
                    onChange={(e) => update('maxValue', e.target.value)}
                    placeholder="No limit"
                  />
                </Field>
              </div>
              <p className="text-[11px] text-ink-muted">Leave empty if there is no limit. Use the company-approved SOP limits.</p>
            </div>
          )}

          {form.type === 'PHOTO' && (
            <p className="p-3 bg-slate-50 border border-line rounded text-xs text-ink-secondary">
              The worker takes a photo with the app camera instead of typing a value. When the parameter is Required on a check type, the photo is required.
            </p>
          )}

          {form.type === 'DROPDOWN' && (
            <div className="p-3 bg-slate-50 border border-line rounded space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">
                  Dropdown options<span className="text-failed"> *</span>
                </span>
                <span className="text-[11px] text-ink-muted">Shown to the worker in this order</span>
              </div>
              <div className="space-y-1.5">
                {form.options.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-5 text-right font-mono text-[11px] text-ink-muted">{index + 1}</span>
                    <TextInput
                      value={option}
                      onChange={(e) => update('options', form.options.map((o, i) => (i === index ? e.target.value : o)))}
                      placeholder={`Option ${index + 1}`}
                    />
                    <button
                      type="button"
                      title="Remove option"
                      disabled={form.options.length === 1}
                      onClick={() => update('options', form.options.filter((_, i) => i !== index))}
                      className="p-1 rounded text-ink-muted hover:text-failed hover:bg-white disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => update('options', [...form.options, ''])}
                icon={<Plus className="w-3 h-3" />}
              >
                Add option
              </Button>
            </div>
          )}

          <Field label="Description / SOP note" hint="Shown to workers as guidance for this field.">
            <TextArea
              rows={2}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="How to measure, instrument to use, SOP reference…"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <Toggle
              checked={form.isRequired}
              onChange={(v) => update('isRequired', v)}
              label="Required by default"
              description="Default when added to a check type. Can be changed per check type."
            />
            <Toggle
              checked={form.isActive}
              onChange={(v) => update('isActive', v)}
              label="Active"
              description="Disabled parameters are hidden from all worker forms."
            />
          </div>

          {/* Allows Enter to submit */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete parameter?"
        danger
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
        message={
          deleting && (
            <div className="space-y-2">
              <p>
                <span className="font-semibold text-ink">{deleting.name}</span> will be removed from{' '}
                {deleting.activityIds.length
                  ? `all ${deleting.activityIds.length} check type${deleting.activityIds.length === 1 ? '' : 's'} that use it`
                  : 'all check types'}
                .
              </p>
              <p>Values already submitted in past checks are kept. To stop using it for now without deleting, disable it instead.</p>
            </div>
          )
        }
      />
    </div>
  )
}
