import React, { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Asterisk,
  Camera,
  CircleCheck,
  Eye,
  EyeOff,
  Filter,
  Hash,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Power,
  Search,
  SlidersHorizontal,
  ToggleLeft,
  Trash2,
  Type,
  X
} from 'lucide-react'
import type { Department, Parameter, ParameterType } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useModuleActions, useCanActivate, ACTIVATION_HINT } from '../../lib/auth'
import { PARAMETER_TYPE_LABEL } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { Modal } from '../../components/common/Modal'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Field, FormError, MultiSelectList, Select, TextArea, TextInput, Toggle } from '../../components/common/Form'
import { Card, EmptyState, InfoTip } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'

const PARAMETER_TYPES: ParameterType[] = ['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL', 'PHOTO']

/** Icon shown with each input type's label in the table. */
const TYPE_ICON: Record<ParameterType, React.ReactNode> = {
  NUMBER: <Hash className="w-3 h-3" />,
  TEXT: <Type className="w-3 h-3" />,
  DROPDOWN: <ListChecks className="w-3 h-3" />,
  YES_NO: <ToggleLeft className="w-3 h-3" />,
  PASS_FAIL: <CircleCheck className="w-3 h-3" />,
  PHOTO: <Camera className="w-3 h-3" />
}

/** A small neutral chip: codes, input types, departments. */
const chip = 'inline-flex items-center h-5 px-1.5 rounded bg-subtle ring-1 ring-inset ring-line text-[11px] text-ink-secondary whitespace-nowrap'

/** Request body for POST / PUT /api/parameters. */
interface ParameterBody {
  name: string
  code: string
  type: ParameterType
  unit: string | null
  minValue: number | null
  maxValue: number | null
  options: string[]
  materialOptions: string[]
  multiSelect: boolean
  isRequired: boolean
  isActive: boolean
  sortOrder: number
  description: string | null
  departmentIds: string[]
}

interface ParameterForm {
  name: string
  code: string
  type: ParameterType
  unit: string
  minValue: string
  maxValue: string
  options: string[]
  materialOptions: string[]
  multiSelect: boolean
  isRequired: boolean
  isActive: boolean
  description: string
  departmentIds: string[]
}

const emptyForm: ParameterForm = {
  name: '',
  code: '',
  type: 'NUMBER',
  unit: '',
  minValue: '',
  maxValue: '',
  options: [''],
  materialOptions: [],
  multiSelect: false,
  isRequired: true,
  isActive: true,
  description: '',
  departmentIds: []
}

const formFromParameter = (p: Parameter): ParameterForm => ({
  name: p.name,
  code: p.code,
  type: p.type,
  unit: p.unit ?? '',
  minValue: p.minValue === null ? '' : String(p.minValue),
  maxValue: p.maxValue === null ? '' : String(p.maxValue),
  options: p.options.length ? [...p.options] : [''],
  materialOptions: [...p.materialOptions],
  multiSelect: p.multiSelect,
  isRequired: p.isRequired,
  isActive: p.isActive,
  description: p.description ?? '',
  departmentIds: [...p.departmentIds]
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
  materialOptions: p.materialOptions,
  multiSelect: p.multiSelect,
  isRequired: p.isRequired,
  isActive: p.isActive,
  sortOrder: p.sortOrder,
  description: p.description,
  departmentIds: p.departmentIds
})

const toNumberOrNull = (value: string) => (value.trim() === '' ? null : Number(value))

export const ParametersPage: React.FC = () => {
  const canActivate = useCanActivate()
  const { canCreate, canEdit, canDelete, canWrite } = useModuleActions('parameters')
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
      return [p.name, p.code, p.departmentNames.join(' '), p.rule ?? '', p.description ?? ''].some((s) => s.toLowerCase().includes(q))
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
    const materialOptions = form.type === 'DROPDOWN' ? form.materialOptions.map((o) => o.trim()).filter(Boolean) : []
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
      materialOptions,
      multiSelect: form.type === 'DROPDOWN' && form.multiSelect,
      isRequired: form.isRequired,
      isActive: form.isActive,
      sortOrder: editing ? editing.sortOrder : nextSortOrder,
      description: form.description.trim() || null,
      departmentIds: form.departmentIds
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

  const departmentOptions = (departments ?? []).filter((d) => d.isActive || form.departmentIds.includes(d.id))
  const filtersActive = search.trim() !== '' || typeFilter !== 'ALL'

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<SlidersHorizontal className="w-4.5 h-4.5" />}
        title="Quality Parameters"
        description={data ? `${activeCount} active · ${parameters.length} total` : 'Fields workers fill in during a check'}
        info="Fields workers fill in during a quality check. Add parameters here, then place them on check types."
        actions={
          canCreate && (
            <Button size="sm" variant="primary" onClick={openAdd} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Parameter
            </Button>
          )
        }
      />

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        empty={data === null ? undefined : parameters.length === 0}
        emptyText="No parameters yet. Add the first one."
      >
        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search parameters" placeholder="Search parameters…" />
            <Select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as ParameterType | 'ALL')}
              aria-label="Filter by parameter type"
              className="sm:w-40"
            >
              <option value="ALL">All input types</option>
              {PARAMETER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PARAMETER_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              aria-pressed={showDisabled}
              onClick={() => setShowDisabled(!showDisabled)}
              className={`inline-flex items-center gap-1.5 h-[40px] lg:h-8 px-2.5 rounded-md border text-[12.5px] font-medium transition-colors ${
                showDisabled ? 'bg-accent-soft border-accent-line text-accent-strong' : 'bg-white border-line-strong text-ink-secondary hover:bg-subtle'
              }`}
            >
              {showDisabled ? <Eye className="w-3.5 h-3.5" aria-hidden /> : <EyeOff className="w-3.5 h-3.5" aria-hidden />}
              Show disabled
            </button>
            <ToolbarSpacer />
            {canEdit && filtersActive && (
              <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-exception-bg text-exception ring-1 ring-inset ring-exception-line text-[11px] font-medium">
                <Filter className="w-3 h-3" aria-hidden />
                Filtered: a row moves past the next visible row
              </span>
            )}
            {canEdit && <InfoTip text="Arrows set the default display order. The order on each worker form is set per check type on the Check Types page." />}
            <ResultCount shown={visible.length} total={parameters.length} noun="parameters" />
          </Toolbar>

          {visible.length === 0 ? (
            <EmptyState icon={<Search className="w-5 h-5" />} title="No parameters match the filters." compact />
          ) : (
            <div className="overflow-x-auto lg:max-h-[calc(100vh-230px)] lg:overflow-y-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th className="w-16">Order</th>
                    <th>Parameter</th>
                    <th>Input type</th>
                    <th>Rule</th>
                    <th>Departments</th>
                    <th>Default</th>
                    <th className="num">Used in</th>
                    <th>Status</th>
                    {canWrite && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p, index) => (
                    <tr key={p.id} className={p.isActive ? '' : 'bg-subtle/50'}>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span className="w-5 font-mono text-[11.5px] text-ink-muted text-right tabular-nums">{positionById.get(p.id)}</span>
                          {canEdit && (
                            <span className="flex lg:flex-col">
                              <button
                                type="button"
                                title="Move up"
                                aria-label={`Move ${p.name} up`}
                                disabled={reordering || index === 0}
                                onClick={() => move(p, -1)}
                                className="w-[36px] h-[36px] lg:w-6 lg:h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ArrowUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                title="Move down"
                                aria-label={`Move ${p.name} down`}
                                disabled={reordering || index === visible.length - 1}
                                onClick={() => move(p, 1)}
                                className="w-[36px] h-[36px] lg:w-6 lg:h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ArrowDown className="w-3 h-3" />
                              </button>
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-semibold ${p.isActive ? 'text-ink' : 'text-ink-muted'}`}>{p.name}</span>
                          <span className={`${chip} font-mono`} title="Code">
                            {p.code}
                          </span>
                        </div>
                        {p.description && <span className="block text-[11.5px] text-ink-muted truncate max-w-xs">{p.description}</span>}
                      </td>
                      <td className="whitespace-nowrap">
                        <span className={`${chip} gap-1 text-ink`}>
                          <span className="text-accent" aria-hidden>
                            {TYPE_ICON[p.type]}
                          </span>
                          {PARAMETER_TYPE_LABEL[p.type]}
                        </span>
                      </td>
                      <td className="min-w-[170px] max-w-[260px]">
                        {p.rule ? (
                          <code className="w-fit max-w-full px-1.5 py-0.5 rounded bg-subtle ring-1 ring-inset ring-line font-mono text-[11.5px] text-ink leading-snug line-clamp-2" title={p.rule}>
                            {p.rule}
                          </code>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td>
                        {p.departmentNames.length ? (
                          <div className="flex flex-wrap gap-1">
                            {p.departmentNames.map((n) => (
                              <span key={n} className={`${chip} rounded-full`}>
                                {n}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-ink-muted whitespace-nowrap" title="Every check type can use it">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {p.isRequired ? (
                          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink">
                            <Asterisk className="w-3 h-3 text-accent" aria-hidden />
                            Required
                          </span>
                        ) : (
                          <span className="text-[12px] text-ink-muted">Optional</span>
                        )}
                      </td>
                      <td className="num whitespace-nowrap">
                        {p.activityIds.length ? (
                          <span className="text-ink" title={`${p.activityIds.length} check type${p.activityIds.length === 1 ? '' : 's'}`}>
                            {p.activityIds.length} <span className="text-ink-muted">type{p.activityIds.length === 1 ? '' : 's'}</span>
                          </span>
                        ) : (
                          <span className="text-ink-faint">Not used</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={p.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                      </td>
                      {canWrite && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            {canEdit && (<IconButton label={`Edit ${p.name}`} onClick={() => openEdit(p)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </IconButton>)}
                            {/* Enabling / disabling: the Super Admin only. */}
                            {canActivate && (
                              <IconButton
                                label={p.isActive ? `Disable ${p.name} (hide from worker forms)` : `Enable ${p.name} (show on worker forms)`}
                                onClick={() => toggleActive(p)}
                                disabled={busyId === p.id}
                                aria-busy={busyId === p.id || undefined}
                                className={p.isActive ? '' : 'text-success'}
                              >
                                {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                              </IconButton>
                            )}
                            {canDelete && (<IconButton label={`Delete ${p.name}`} tone="danger" onClick={() => setDeleting(p)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </IconButton>)}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
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
            {/* Not a <Field>: that renders a <label>, which would bind the heading to the first box. */}
            <div>
              <span className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary mb-1.5">Departments</span>
              <MultiSelectList
                items={departmentOptions.map((d) => ({ id: d.id, label: d.name, detail: d.isActive ? null : 'disabled' }))}
                selected={form.departmentIds}
                onChange={(ids) => update('departmentIds', ids)}
                emptyText={departments === null ? 'Loading departments…' : 'No departments configured yet'}
              />
              <span className="block text-[11px] text-ink-muted mt-1">
                {form.departmentIds.length
                  ? `${form.departmentIds.length} selected. Only these departments' check types can use this parameter.`
                  : 'None selected: unassigned, so every check type can use it.'}
              </span>
            </div>
          </div>

          {form.type === 'NUMBER' && (
            <div className="p-3 bg-subtle/60 border border-line rounded-md space-y-2">
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
            <p className="flex items-start gap-2 p-3 bg-subtle/60 border border-line rounded-md text-[12px] text-ink-secondary">
              <Camera className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden />
              The worker takes a photo with the app camera instead of typing a value. When the parameter is Required on a check type, the photo is required.
            </p>
          )}

          {form.type === 'DROPDOWN' && (
            <div className="p-3 bg-subtle/60 border border-line rounded-md space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-ink-secondary">First choice (optional)</span>
                <span className="text-[11px] text-ink-muted">Asked before the options below</span>
              </div>
              <div className="space-y-1.5">
                {form.materialOptions.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-5 text-right font-mono text-[11px] text-ink-muted">{index + 1}</span>
                    <TextInput
                      value={option}
                      onChange={(e) => update('materialOptions', form.materialOptions.map((o, i) => (i === index ? e.target.value : o)))}
                      aria-label={`Material ${index + 1}`}
                      placeholder="e.g. BOPP 38"
                    />
                    <button
                      type="button"
                      title="Remove"
                      aria-label={`Remove material ${index + 1}`}
                      onClick={() => update('materialOptions', form.materialOptions.filter((_, i) => i !== index))}
                      className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-ink-muted hover:text-failed hover:bg-white"
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
                onClick={() => update('materialOptions', [...form.materialOptions, ''])}
                icon={<Plus className="w-3 h-3" />}
              >
                Add first choice
              </Button>
              <p className="text-[11px] text-ink-muted">
                {form.materialOptions.some((o) => o.trim())
                  ? 'The worker picks one of these first, then one of the options below. Both are recorded together, e.g. "BOPP 38, 40 Dyne".'
                  : 'Leave empty for an ordinary dropdown. Fill it in to ask the worker something first, such as the material.'}
              </p>
              <div className="flex items-center justify-between pt-1 border-t border-line">
                <span className="text-[12.5px] font-semibold text-ink-secondary">
                  Dropdown options<span className="text-missed"> *</span>
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
                      aria-label={`Option ${index + 1}`}
                      placeholder={`Option ${index + 1}`}
                    />
                    <button
                      type="button"
                      title="Remove option"
                      aria-label={`Remove option ${index + 1}`}
                      disabled={form.options.length === 1}
                      onClick={() => update('options', form.options.filter((_, i) => i !== index))}
                      className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-ink-muted hover:text-failed hover:bg-white disabled:opacity-30 disabled:hover:bg-transparent"
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
              <div className="pt-1 border-t border-line">
                <Toggle
                  checked={form.multiSelect}
                  onChange={(v) => update('multiSelect', v)}
                  label="Allow multiple selection"
                  description={
                    form.multiSelect
                      ? 'The worker can pick several options; they are recorded together, separated by commas.'
                      : 'The worker picks one option.'
                  }
                />
              </div>
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
              disabled={!canActivate}
              onChange={(v) => update('isActive', v)}
              label="Active"
              description={canActivate ? 'Disabled parameters are hidden from all worker forms.' : ACTIVATION_HINT}
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
