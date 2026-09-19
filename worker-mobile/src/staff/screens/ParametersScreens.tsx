import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Department, Parameter, ParameterType } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { PARAMETER_TYPE_LABEL } from '../format'
import {
  AccessDenied,
  Badge,
  Chips,
  DataState,
  FieldLabel,
  FormError,
  FormSection,
  IconButton,
  Input,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  SelectField,
  SmallButton,
  SwitchKnob,
  ToggleField,
  confirm,
  useToast
} from '../ui'
import { ActionGroup, ActionItem, SummaryHeader, facts } from './adminParts'

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

const usedInText = (p: Parameter) => (p.activityIds.length ? `${p.activityIds.length} check type${p.activityIds.length === 1 ? '' : 's'}` : 'Not used')

/** A compact on/off switch for a list option (e.g. "Show disabled"). */
const CompactToggle: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
  <Pressable
    onPress={() => onChange(!value)}
    accessibilityRole="switch"
    accessibilityState={{ checked: value }} aria-checked={value}
    accessibilityLabel={label}
    className="min-h-[44px] flex-row items-center gap-2 rounded-full pl-1"
  >
    <Text className="text-[14px] font-medium text-staff-ink2">{label}</Text>
    <SwitchKnob value={value} />
  </Pressable>
)

/** Quality Parameters: fields workers fill in during a check; manage users add, edit and reorder them. */
export const ParametersScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const notify = useToast()
  const canEdit = can('parameters', 'manage')
  const { data, error, loading, reload, setData } = useQuery<Parameter[]>('/api/parameters')

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<ParameterType | ''>('')
  const [showDisabled, setShowDisabled] = useState(true)
  const [reorderMode, setReorderMode] = useState(false)
  const [reordering, setReordering] = useState(false)

  const parameters = useMemo(() => data ?? [], [data])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return parameters.filter((p) => {
      if (!showDisabled && !p.isActive) return false
      if (typeFilter && p.type !== typeFilter) return false
      if (!q) return true
      return [p.name, p.code, p.rule ?? '', p.description ?? ''].some((s) => s.toLowerCase().includes(q))
    })
  }, [parameters, search, typeFilter, showDisabled])

  const positionById = useMemo(() => new Map(parameters.map((p, index) => [p.id, index + 1])), [parameters])
  const activeCount = parameters.filter((p) => p.isActive).length
  const nextSortOrder = parameters.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1
  const filtersActive = search.trim() !== '' || typeFilter !== ''

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

  const headerActions = [
    ...(canEdit && !reorderMode ? [{ label: 'Add', icon: 'add' as const, onPress: () => push('parameterForm', { nextSortOrder }) }] : []),
    ...(canEdit && parameters.length > 1
      ? [{ label: reorderMode ? 'Done' : 'Reorder', icon: reorderMode ? ('checkmark' as const) : ('swap-vertical-outline' as const), onPress: () => setReorderMode((v) => !v) }]
      : [])
  ]

  const typeChips = [{ value: '' as const, label: 'All types' }, ...PARAMETER_TYPES.map((t) => ({ value: t, label: PARAMETER_TYPE_LABEL[t] }))]

  return (
    <Screen title="Quality Parameters" onRefresh={reload} refreshing={loading && !!data} right={headerActions.length ? headerActions : null}>
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name, code or rule" />
        <Chips<ParameterType | ''> options={typeChips} value={typeFilter} onChange={setTypeFilter} />
        <View className="flex-row items-center justify-between gap-2 px-1">
          <Text className="flex-1 text-[13px] leading-[18px] text-staff-muted">
            {activeCount} active of {parameters.length}. Add parameters here, then place them on check types.
          </Text>
          <CompactToggle label="Show disabled" value={showDisabled} onChange={setShowDisabled} />
        </View>
      </View>

      {canEdit && reorderMode ? (
        <Notice
          tone="accent"
          icon="swap-vertical-outline"
          message={`Arrows set the default display order. The order on each worker form is set per check type on the Check Types page.${
            filtersActive ? ' Filters are on: a row moves past the next visible row.' : ''
          }`}
        />
      ) : null}

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && visible.length === 0}
        emptyText={parameters.length === 0 ? 'No parameters yet. Add the first one.' : 'No parameters match the filters.'}
        emptyIcon="speedometer-outline"
      >
        <List>
          {visible.map((p, index) => (
            <Row
              key={p.id}
              title={`${positionById.get(p.id)}. ${p.name}`}
              titleClassName={p.isActive ? '' : 'text-staff-muted'}
              subtitle={facts(p.code, PARAMETER_TYPE_LABEL[p.type], p.isRequired ? 'Required' : 'Optional', p.departmentName)}
              detail={facts(p.rule ? `Rule: ${p.rule}` : null, `Used in: ${usedInText(p)}`)}
              detailLines={1}
              right={
                canEdit && reorderMode ? (
                  <View className="flex-row gap-1.5">
                    <IconButton icon="arrow-up" accessibilityLabel={`Move ${p.name} up`} disabled={reordering || index === 0} onPress={() => move(p, -1)} />
                    <IconButton icon="arrow-down" accessibilityLabel={`Move ${p.name} down`} disabled={reordering || index === visible.length - 1} onPress={() => move(p, 1)} />
                  </View>
                ) : p.isActive ? undefined : (
                  <Badge label="Disabled" tone="missed" />
                )
              }
              onPress={canEdit && !reorderMode ? () => push('parameterForm', { parameter: p, nextSortOrder }) : undefined}
              accessibilityLabel={canEdit ? `Edit ${p.name}` : undefined}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** Add or edit a parameter: what the worker enters and the limits used to pass or fail the value. */
export const ParameterFormScreen: React.FC<{ params: { parameter?: Parameter; nextSortOrder?: number } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('parameters', 'manage')
  const editing = params.parameter ?? null
  const { data: departments } = useQuery<Department[]>(canEdit ? '/api/departments' : null)

  const [form, setForm] = useState<ParameterForm>(() => (editing ? formFromParameter(editing) : emptyForm))
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const update = <K extends keyof ParameterForm>(key: K, value: ParameterForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    const isNumber = form.type === 'NUMBER'
    const options = form.type === 'DROPDOWN' ? form.options.map((o) => o.trim()).filter(Boolean) : []
    const minValue = isNumber ? toNumberOrNull(form.minValue) : null
    const maxValue = isNumber ? toNumberOrNull(form.maxValue) : null

    if (form.type === 'DROPDOWN' && options.length === 0) return setFormError('Add at least one dropdown option')
    if ((minValue !== null && !Number.isFinite(minValue)) || (maxValue !== null && !Number.isFinite(maxValue))) {
      return setFormError('Minimum and maximum must be numbers')
    }

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
      sortOrder: editing ? editing.sortOrder : (params.nextSortOrder ?? 0),
      description: form.description.trim() || null,
      departmentId: form.departmentId || null
    }

    setSaving(true)
    setFormError(null)
    try {
      if (editing) await api.put(`/api/parameters/${editing.id}`, body)
      else await api.post('/api/parameters', body)
      notify('success', editing ? 'Parameter updated' : 'Parameter added', body.name)
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async () => {
    if (!editing) return
    setToggling(true)
    try {
      await api.put(`/api/parameters/${editing.id}`, { ...bodyFromParameter(editing), isActive: !editing.isActive })
      notify(
        'success',
        editing.isActive ? 'Parameter disabled' : 'Parameter enabled',
        editing.isActive ? `${editing.name} is hidden from worker forms.` : `${editing.name} is shown on worker forms again.`
      )
      pop()
    } catch (err) {
      notify('error', 'Could not update parameter', errorText(err))
    } finally {
      setToggling(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    const count = editing.activityIds.length
    const ok = await confirm(
      'Delete parameter?',
      `${editing.name} will be removed from ${count ? `all ${count} check type${count === 1 ? '' : 's'} that use it` : 'all check types'}.\n\nValues already submitted in past checks are kept. To stop using it for now without deleting, disable it instead.`,
      'Delete',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      await api.del(`/api/parameters/${editing.id}`)
      notify('success', 'Parameter deleted', editing.name)
      pop()
    } catch (err) {
      notify('error', 'Could not delete parameter', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  if (!canEdit) {
    return (
      <Screen title={editing ? 'Edit Parameter' : 'Add Parameter'}>
        <AccessDenied title="You do not have permission to change parameters." />
      </Screen>
    )
  }

  const departmentOptions = (departments ?? []).filter((d) => d.isActive || d.id === form.departmentId)

  return (
    <Screen
      title={editing ? 'Edit Parameter' : 'Add Parameter'}
      subtitle={editing ? editing.code : null}
      footer={<PrimaryButton label={editing ? 'Save changes' : 'Add parameter'} onPress={submit} loading={saving} />}
    >
      <FormError message={formError} />

      {editing ? (
        <SummaryHeader
          title={editing.name}
          caption={facts(`Used in: ${usedInText(editing)}`, editing.rule ? `Rule: ${editing.rule}` : null)}
          status={editing.isActive ? null : { label: 'Disabled', tone: 'missed' }}
        />
      ) : null}

      <FormSection title="Details" description="What the worker enters">
        <Input label="Parameter name" required value={form.name} onChangeText={(v) => update('name', v)} placeholder="e.g. Ink Viscosity" maxLength={120} />
        <Input label="Code" required value={form.code} onChangeText={(v) => update('code', v)} placeholder="e.g. VISCOSITY" autoCapitalize="characters" maxLength={40} />
        <SelectField
          label="Input type"
          required
          value={form.type}
          options={PARAMETER_TYPES.map((t) => ({ value: t, label: PARAMETER_TYPE_LABEL[t] }))}
          onChange={(v) => v && update('type', v)}
        />
        <SelectField
          label="Department"
          hint="Optional. Helps group parameters."
          value={form.departmentId}
          emptyLabel="All departments"
          options={departmentOptions.map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => update('departmentId', v)}
        />
        <Input
          label="Description / SOP note"
          hint="Shown to workers as guidance for this field."
          value={form.description}
          onChangeText={(v) => update('description', v)}
          placeholder="How to measure, instrument to use, SOP reference…"
          multiline
          maxLength={500}
        />
      </FormSection>

      {form.type === 'NUMBER' ? (
        <FormSection title="Rule" description="Leave empty if there is no limit. Use the company-approved SOP limits.">
          <Input label="Unit" value={form.unit} onChangeText={(v) => update('unit', v)} placeholder="sec, mm, °C" autoCapitalize="none" maxLength={30} />
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input label="Minimum" value={form.minValue} onChangeText={(v) => update('minValue', v)} placeholder="No limit" keyboardType="numbers-and-punctuation" />
            </View>
            <View className="flex-1">
              <Input label="Maximum" value={form.maxValue} onChangeText={(v) => update('maxValue', v)} placeholder="No limit" keyboardType="numbers-and-punctuation" />
            </View>
          </View>
        </FormSection>
      ) : null}

      {form.type === 'PHOTO' ? (
        <FormSection
          title="Rule"
          description="The worker takes a photo with the app camera instead of typing a value. When the parameter is Required on a check type, the photo is required."
        >
          {null}
        </FormSection>
      ) : null}

      {form.type === 'DROPDOWN' ? (
        <FormSection title="Rule">
          <View className="-mb-2">
            <FieldLabel label="Dropdown options" required hint="Shown to the worker in this order" />
          </View>
          {form.options.map((option, index) => (
            <View key={index} className="flex-row items-end gap-2">
              <View className="flex-1">
                <Input
                  label={`Option ${index + 1}`}
                  value={option}
                  onChangeText={(v) => update('options', form.options.map((o, i) => (i === index ? v : o)))}
                  placeholder={`Option ${index + 1}`}
                  maxLength={100}
                />
              </View>
              <View className="mb-1">
                <IconButton
                  icon="trash-outline"
                  variant="plain"
                  tone="danger"
                  accessibilityLabel={`Remove option ${index + 1}`}
                  disabled={form.options.length === 1}
                  onPress={() => update('options', form.options.filter((_, i) => i !== index))}
                />
              </View>
            </View>
          ))}
          <SmallButton label="Add option" icon="add" onPress={() => update('options', [...form.options, ''])} className="self-start" />
        </FormSection>
      ) : null}

      <FormSection title="Availability">
        <View className="gap-2">
          <ToggleField
            label="Required by default"
            description="Default when added to a check type. Can be changed per check type."
            value={form.isRequired}
            onChange={(v) => update('isRequired', v)}
          />
          <ToggleField label="Active" description="Disabled parameters are hidden from all worker forms." value={form.isActive} onChange={(v) => update('isActive', v)} />
        </View>
      </FormSection>

      {editing ? (
        <ActionGroup>
          <ActionItem
            label={editing.isActive ? 'Disable' : 'Enable'}
            accessibilityLabel={editing.isActive ? 'Hide from worker forms' : 'Show on worker forms'}
            description={
              toggling
                ? 'Saving…'
                : editing.isActive
                  ? 'Hide from worker forms. Unsaved changes above are not applied.'
                  : 'Show on worker forms. Unsaved changes above are not applied.'
            }
            onPress={toggleActive}
            disabled={toggling || deleting}
          />
          <ActionItem
            label="Delete parameter"
            description={deleting ? 'Deleting…' : null}
            tone="danger"
            onPress={remove}
            disabled={toggling || deleting}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const PARAMETERS_SCREENS = {
  parameters: ParametersScreen,
  parameterForm: ParameterFormScreen
}
