import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { Activity, AppliesWhen, Department, Machine, Parameter, ParameterType } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { PARAMETER_TYPE_LABEL } from '../format'
import {
  Badge,
  Card,
  DataState,
  Empty,
  FormError,
  FormSection,
  IconButton,
  Input,
  KV,
  List,
  MultiSelectField,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SelectField,
  SmallButton,
  SwitchKnob,
  ToggleField,
  confirm,
  useToast,
  AccessDenied
} from '../ui'
import { ActionGroup, ActionItem, SummaryHeader, facts } from './adminParts'

interface FormParameter {
  parameterId: string
  isRequired: boolean
  isEnabled: boolean
  /** Evidence the worker captures for this parameter alone. */
  requirePhoto: boolean
  requireVideo: boolean
  /** The worker may mark this parameter "Not applicable" with one of the N/A reasons. */
  allowNa: boolean
  /** JOB_RUNNING parameters are skipped automatically when no job runs on the machine. */
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
  allowManual: a.allowManual ?? true,
  parameters: a.parameters.map((p) => ({
    parameterId: p.parameterId,
    isRequired: p.isRequired,
    isEnabled: p.isEnabled,
    requirePhoto: p.requirePhoto ?? false,
    requireVideo: p.requireVideo ?? false,
    allowNa: p.allowNa ?? false,
    appliesWhen: p.appliesWhen ?? 'ALWAYS'
  })),
  machineIds: [...a.machineIds]
})

/** Job No. / Photo / Video labels for what the worker must provide for the whole check. */
const evidenceLabels = (a: Pick<Activity, 'requireJobNo' | 'requirePhoto' | 'requireVideo'>) =>
  [a.requireJobNo && 'Job No.', a.requirePhoto && 'Overall photo', a.requireVideo && 'Overall video'].filter((x): x is string => !!x)

/** "Photo · Video · N/A · Only during a job" for one parameter of the check type. */
const parameterFlags = (p: Activity['parameters'][number]) =>
  [p.requirePhoto && 'Photo', p.requireVideo && 'Video', p.allowNa && 'N/A allowed', p.appliesWhen === 'JOB_RUNNING' && 'Only during a job'].filter(
    (x): x is string => !!x
  )

/** Parameters shown to workers (enabled here and active globally). */
const shownParameters = (a: Activity) => a.parameters.filter((p) => p.isEnabled && p.parameterActive)

/** Deletes a check type (or disables it when it has history), with the web panel's wording. */
async function deleteActivity(activity: Activity, notify: ReturnType<typeof useToast>) {
  const ok = await confirm(
    'Delete check type?',
    `${activity.name} will be deleted and its upcoming pending checks removed.\n\nIf it already has recorded checks or schedules, it will be disabled instead so the history is kept.`,
    'Delete',
    true
  )
  if (!ok) return false
  try {
    const { result } = await api.del(`/api/activities/${activity.id}`)
    if (result === 'disabled') {
      notify('warning', 'Check type disabled', `${activity.name} already has quality checks or schedules, so it was disabled instead of deleted to keep history.`)
    } else {
      notify('success', 'Check type deleted', activity.name)
    }
    return true
  } catch (err) {
    notify('error', 'Could not delete check type', errorText(err))
    return false
  }
}

/** A compact on/off switch for per-parameter settings inside a form card. */
const CompactToggle: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
  <Pressable
    onPress={() => onChange(!value)}
    accessibilityRole="switch"
    accessibilityState={{ checked: value }} aria-checked={value}
    accessibilityLabel={label}
    className="min-h-[44px] flex-1 flex-row items-center justify-between gap-1.5 rounded-xl bg-staff-fill py-1.5 pl-3 pr-1.5"
  >
    <Text className="flex-1 text-[14px] font-medium leading-[19px] text-staff-ink" numberOfLines={2}>
      {label}
    </Text>
    <SwitchKnob value={value} />
  </Pressable>
)

const machinesLabel = (count: number) => (count ? `${count} machine${count === 1 ? '' : 's'}` : 'No machines')

/** Check Types: what workers fill in for each quality check (parameters, evidence and machines). */
export const ActivitiesScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('activities', 'manage')
  const { data, error, loading, reload } = useQuery<Activity[]>('/api/activities')
  const [search, setSearch] = useState('')

  const activities = useMemo(() => data ?? [], [data])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return activities
    return activities.filter((a) => [a.name, a.code, a.departmentName ?? '', a.description ?? ''].some((s) => s.toLowerCase().includes(q)))
  }, [activities, search])

  return (
    <Screen
      title="Check Types"
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('activityForm', {}) } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name, code or department" />
        <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
          {data ? `${activities.filter((a) => a.isActive).length} active of ${activities.length}. ` : ''}
          What workers fill in for each quality check. Changes apply to the worker app immediately.
        </Text>
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && visible.length === 0}
        emptyText={activities.length === 0 ? 'No check types yet. Add the first one.' : 'No check types match the search.'}
        emptyIcon="list-outline"
      >
        <List>
          {visible.map((a) => (
            <Row
              key={a.id}
              title={a.name}
              titleClassName={a.isActive ? '' : 'text-staff-muted'}
              subtitle={facts(a.code, `${shownParameters(a).length} on form`, machinesLabel(a.machineIds.length))}
              right={a.isActive ? undefined : <Badge label="Disabled" tone="missed" />}
              onPress={() => push('activityDetail', { id: a.id })}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** One check type: its worker form requirements, parameters in order and machines; users with "manage" edit or delete it here. */
export const ActivityDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('activities', 'manage')
  const { data, error, loading, reload } = useQuery<Activity[]>('/api/activities')
  const machinesApi = useQuery<Machine[]>('/api/machines')
  const activity = (data ?? []).find((a) => a.id === params.id) ?? null
  const machineById = useMemo(() => new Map((machinesApi.data ?? []).map((m) => [m.id, m])), [machinesApi.data])

  const remove = async () => {
    if (activity && (await deleteActivity(activity, notify))) pop()
  }

  const evidence = activity ? evidenceLabels(activity) : []

  return (
    <Screen
      title="Check Type"
      right={canEdit && activity ? { label: 'Edit', icon: 'create-outline', onPress: () => push('activityForm', { id: activity.id }) } : null}
      onRefresh={() => {
        reload()
        machinesApi.reload()
      }}
      refreshing={loading && !!data}
    >
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && !activity}
        emptyText="This check type could not be found."
        emptyIcon="list-outline"
      >
        {activity ? (
          <>
            <SummaryHeader
              title={activity.name}
              caption={facts(activity.code, `${shownParameters(activity).length} on form`, machinesLabel(activity.machineIds.length))}
              status={activity.isActive ? null : { label: 'Disabled', tone: 'missed' }}
            />

            <Section title="Details">
              <Card>
                <KV label="Department" value={activity.departmentName} />
                <KV
                  label="Evidence"
                  value={evidence.length ? evidence.join(' · ') : 'None required'}
                  detail="Per-parameter photo and video are listed with each parameter below."
                />
                <KV label="Manual submission" value={activity.allowManual ? 'Allowed' : 'Notification only'} />
                {activity.description ? <KV stacked label="Description" value={activity.description} /> : null}
              </Card>
            </Section>

            <Section title="Parameters on this form" detail={`${shownParameters(activity).length} on form · workers see them in this order`}>
              {activity.parameters.length === 0 ? (
                <Empty text="No parameters" icon="speedometer-outline" />
              ) : (
                <List>
                  {activity.parameters.map((p, index) => (
                    <Row
                      key={p.parameterId}
                      title={`${index + 1}. ${p.name}`}
                      titleClassName={p.isEnabled ? '' : 'text-staff-muted'}
                      subtitle={`${PARAMETER_TYPE_LABEL[p.type]}${p.unit ? ` · ${p.unit}` : ''} · ${p.isRequired ? 'Required' : 'Optional'}`}
                      detail={
                        [...parameterFlags(p), !p.isEnabled && 'Off on this form', !p.parameterActive && 'Disabled globally'].filter(Boolean).join(' · ') || null
                      }
                    />
                  ))}
                </List>
              )}
            </Section>

            <Section title="Machines" detail={machinesLabel(activity.machineIds.length)}>
              {activity.machineIds.length ? (
                <List>
                  {activity.machineIds.map((id) => {
                    const m = machineById.get(id)
                    return (
                      <Row
                        key={id}
                        title={m?.name ?? (machinesApi.loading ? 'Loading…' : 'Unknown machine')}
                        subtitle={m?.code ?? null}
                        right={m && !m.isActive ? <Badge label="Inactive" tone="missed" /> : undefined}
                      />
                    )
                  })}
                </List>
              ) : null}
            </Section>

            {canEdit ? (
              <ActionGroup>
                <ActionItem label="Delete check type" tone="danger" onPress={remove} />
              </ActionGroup>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Add or edit a check type: details, worker form requirements, ordered parameters and machines. */
const ActivityForm: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { pop } = useStaff()
  const notify = useToast()
  const isNew = !params.id
  const activitiesApi = useQuery<Activity[]>('/api/activities')
  const { data: allParameters } = useQuery<Parameter[]>('/api/parameters')
  const { data: machines } = useQuery<Machine[]>('/api/machines')
  const { data: departments } = useQuery<Department[]>('/api/departments')

  const activities = useMemo(() => activitiesApi.data ?? [], [activitiesApi.data])
  const editing = isNew ? null : (activities.find((a) => a.id === params.id) ?? null)

  const [form, setForm] = useState<ActivityForm>(emptyForm)
  const [loaded, setLoaded] = useState(isNew)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addParameterId, setAddParameterId] = useState('')

  useEffect(() => {
    if (loaded || !editing) return
    setForm(formFromActivity(editing))
    setLoaded(true)
  }, [editing, loaded])

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

  const submit = async () => {
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
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const departmentOptions = (departments ?? []).filter((d) => d.isActive || d.id === form.departmentId).map((d) => ({ value: d.id, label: d.name }))
  const machineOptions = (machines ?? [])
    .filter((m) => m.isActive || form.machineIds.includes(m.id))
    .map((m) => ({ value: m.id, label: m.isActive ? m.name : `${m.name} (inactive)`, detail: m.code }))
  const addOptions = availableParameters.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.code})`,
    detail: `${PARAMETER_TYPE_LABEL[p.type]}${p.isActive ? '' : ' · disabled'}`
  }))
  const enabledOnForm = form.parameters.filter((p) => p.isEnabled).length

  return (
    <Screen
      title={isNew ? 'Add Check Type' : 'Edit Check Type'}
      subtitle="Saved changes apply to the worker app immediately"
      footer={loaded ? <PrimaryButton label={isNew ? 'Create check type' : 'Save changes'} onPress={submit} loading={saving} /> : undefined}
    >
      <DataState
        loading={!isNew && activitiesApi.loading}
        error={isNew ? null : activitiesApi.error}
        onRetry={activitiesApi.reload}
        hasData={loaded}
        empty={!isNew && !!activitiesApi.data && !editing && !loaded}
        emptyText="This check type could not be found."
        emptyIcon="list-outline"
      >
        {loaded ? (
          <>
            <FormError message={formError} />

            <FormSection title="Details">
              <Input label="Name" required value={form.name} onChangeText={(v) => update('name', v)} placeholder="e.g. Printing Hourly Check" />
              <Input label="Code" required value={form.code} onChangeText={(v) => update('code', v)} placeholder="e.g. PRT-HOURLY" autoCapitalize="characters" />
              <SelectField label="Department" value={form.departmentId} emptyLabel="No department" options={departmentOptions} onChange={(v) => update('departmentId', v)} />
              <Input
                label="Description"
                value={form.description}
                onChangeText={(v) => update('description', v)}
                multiline
                placeholder="When this check is done and any SOP reference…"
              />
              <ToggleField
                label="Active"
                description="Inactive check types are not scheduled and upcoming checks are removed."
                value={form.isActive}
                onChange={(v) => update('isActive', v)}
              />
            </FormSection>

            <FormSection title="Worker form requirements" description="What the worker must provide before submitting. Prefer per-parameter evidence below over one photo for the whole check.">
              <View className="gap-2">
                <ToggleField label="Job No. required" description="Worker enters the job number." value={form.requireJobNo} onChange={(v) => update('requireJobNo', v)} />
                <ToggleField
                  label="Allow manual submission"
                  description="Worker may start this check from the machine screen without waiting for a notification."
                  value={form.allowManual}
                  onChange={(v) => update('allowManual', v)}
                />
                <ToggleField
                  label="Overall check photo"
                  description="One live photo for the whole check. Prefer per-parameter evidence below."
                  value={form.requirePhoto}
                  onChange={(v) => update('requirePhoto', v)}
                />
                <ToggleField
                  label="Overall check video"
                  description="One video up to 60 seconds for the whole check. Prefer per-parameter evidence below."
                  value={form.requireVideo}
                  onChange={(v) => update('requireVideo', v)}
                />
              </View>
            </FormSection>

            <FormSection
              title="Parameters"
              description={`Workers see them in this order. ${enabledOnForm} of ${form.parameters.length} enabled. Turn a parameter off to hide it from this form without losing its settings. Photo and Video ask for evidence on that parameter alone; Allow N/A lets the worker mark it not applicable with a reason.`}
            >
              {form.parameters.length === 0 ? (
                <Text className="text-[14px] leading-[19px] text-staff-muted">No parameters yet. Add them below.</Text>
              ) : (
                <View>
                  {form.parameters.map((fp, index) => {
                    const info = parameterInfo.get(fp.parameterId)
                    const name = info?.name ?? 'parameter'
                    return (
                      <View key={fp.parameterId} className={`gap-2.5 py-3 ${index > 0 ? 'border-t border-staff-line' : ''}`}>
                        <View className="flex-row items-start gap-2">
                          <Text className="w-6 pt-0.5 text-[14px] font-semibold text-staff-muted">{index + 1}</Text>
                          <View className="flex-1">
                            <Text className={`text-[15px] font-semibold leading-[20px] ${fp.isEnabled ? 'text-staff-ink' : 'text-staff-muted'}`}>
                              {info?.name ?? 'Unknown parameter'}
                            </Text>
                            <Text className="text-[13px] leading-[17px] text-staff-muted">
                              {info ? PARAMETER_TYPE_LABEL[info.type] : ''}
                              {info?.unit ? ` · ${info.unit}` : ''}
                            </Text>
                            {info && !info.isActive ? (
                              <View className="mt-1">
                                <Badge label="Disabled globally" tone="exception" />
                              </View>
                            ) : null}
                          </View>
                        </View>
                        <View className="gap-2">
                          <View className="flex-row gap-2">
                            <CompactToggle label="Required" value={fp.isRequired} onChange={(v) => updateParameter(index, { isRequired: v })} />
                            <CompactToggle label="Enabled" value={fp.isEnabled} onChange={(v) => updateParameter(index, { isEnabled: v })} />
                          </View>
                          <View className="flex-row gap-2">
                            <CompactToggle label="Photo" value={fp.requirePhoto} onChange={(v) => updateParameter(index, { requirePhoto: v })} />
                            <CompactToggle label="Video" value={fp.requireVideo} onChange={(v) => updateParameter(index, { requireVideo: v })} />
                          </View>
                          <View className="flex-row gap-2">
                            <CompactToggle label="Allow N/A" value={fp.allowNa} onChange={(v) => updateParameter(index, { allowNa: v })} />
                          </View>
                          <View className="flex-row gap-2">
                            <CompactToggle
                              label="Only while a job is running"
                              value={fp.appliesWhen === 'JOB_RUNNING'}
                              onChange={(v) => updateParameter(index, { appliesWhen: v ? 'JOB_RUNNING' : 'ALWAYS' })}
                            />
                          </View>
                        </View>
                        <View className="flex-row justify-end gap-2">
                            <IconButton icon="arrow-up" accessibilityLabel={`Move ${name} up`} disabled={index === 0} onPress={() => moveParameter(index, -1)} />
                            <IconButton
                              icon="arrow-down"
                              accessibilityLabel={`Move ${name} down`}
                              disabled={index === form.parameters.length - 1}
                              onPress={() => moveParameter(index, 1)}
                            />
                            <IconButton icon="trash-outline" variant="plain" tone="danger" accessibilityLabel={`Remove ${name} from this check type`} onPress={() => removeParameter(index)} />
                        </View>
                      </View>
                    )
                  })}
                </View>
              )}

              <View className="gap-2">
                <SelectField
                  label="Add a parameter"
                  value={addParameterId}
                  options={addOptions}
                  onChange={setAddParameterId}
                  disabled={allParameters === null || availableParameters.length === 0}
                  placeholder={
                    allParameters === null ? 'Loading…' : availableParameters.length ? 'Choose parameter…' : 'All parameters added'
                  }
                />
                <SmallButton label="Add" icon="add" onPress={addParameter} disabled={!addParameterId} className="self-start" />
              </View>
            </FormSection>

            <FormSection title="Machines" description="Which machines use this check type">
              <MultiSelectField
                label={`Machines (${form.machineIds.length} selected)`}
                values={form.machineIds}
                options={machineOptions}
                onChange={(ids) => update('machineIds', ids)}
                placeholder={machines === null ? 'Loading machines…' : machineOptions.length === 0 ? 'No machines configured yet' : 'None selected'}
              />
            </FormSection>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Opened only with manage access; if that access is removed meanwhile, show why instead of a form the server refuses. */
export const ActivityFormScreen: typeof ActivityForm = (props) => {
  const { can } = useStaff()
  return can('activities', 'manage') ? <ActivityForm {...props} /> : (
    <Screen title="Check type">
      <AccessDenied />
    </Screen>
  )
}

export const ACTIVITIES_SCREENS = {
  activities: ActivitiesScreen,
  activityDetail: ActivityDetailScreen,
  activityForm: ActivityFormScreen
}
