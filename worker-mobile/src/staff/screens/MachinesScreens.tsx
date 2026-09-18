import React, { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import type { Activity, Department, Machine, MachineStatus } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import {
  Badge,
  Card,
  Chips,
  DataState,
  Empty,
  FormError,
  FormSection,
  Input,
  KV,
  List,
  MultiSelectField,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SelectField,
  ToggleField,
  confirm,
  useToast,
  AccessDenied
} from '../ui'
import type { Tone } from '../format'
import { ActionGroup, ActionItem, SummaryHeader, facts } from './adminParts'

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

const NO_DEPARTMENT = 'NONE'

/** Deletes a machine (or disables it when it has history), with the web panel's wording. */
async function deleteMachine(machine: Machine, notify: ReturnType<typeof useToast>) {
  const ok = await confirm(
    'Delete machine',
    `Delete ${machine.name}? Its upcoming checks are removed. If it has check history or schedules, it will be disabled instead so history is kept.`,
    'Delete',
    true
  )
  if (!ok) return false
  try {
    const { result } = await api.del(`/api/machines/${machine.id}`)
    if (result === 'disabled') {
      notify('warning', 'Machine disabled', `${machine.name} has check history or schedules, so it was disabled instead of deleted.`)
    } else {
      notify('success', 'Machine deleted', machine.name)
    }
    return true
  } catch (err) {
    notify('error', 'Could not delete machine', errorText(err))
    return false
  }
}

const typesLabel = (count: number) => (count === 0 ? 'No check types' : `${count} ${count === 1 ? 'type' : 'types'}`)

/** A status worth showing: disabled, in maintenance or idle. Running machines show none. */
const machineFlag = (m: Machine): { label: string; tone: Tone } | null =>
  !m.isActive
    ? { label: 'Disabled', tone: 'missed' }
    : m.status === 'MAINTENANCE'
      ? { label: 'Maintenance', tone: 'exception' }
      : m.status === 'IDLE'
        ? { label: 'Idle', tone: 'neutral' }
        : null

/** Machines: production machines and the quality check types performed on each. */
export const MachinesScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('machines', 'manage')
  const machinesApi = useQuery<Machine[]>('/api/machines')
  const departmentsApi = useQuery<Department[]>('/api/departments')

  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')

  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const departments = departmentsApi.data ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return machines.filter((m) => {
      if (deptFilter === NO_DEPARTMENT && m.departmentId) return false
      if (deptFilter && deptFilter !== NO_DEPARTMENT && m.departmentId !== deptFilter) return false
      if (!q) return true
      return [m.name, m.code, m.line, m.model, m.departmentName].some((v) => v?.toLowerCase().includes(q))
    })
  }, [machines, search, deptFilter])

  const deptChips = [
    { value: '', label: 'All departments' },
    ...departments.map((d) => ({ value: d.id, label: d.name })),
    { value: NO_DEPARTMENT, label: 'No department' }
  ]

  return (
    <Screen
      title="Machines"
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('machineForm', {}) } : null}
      onRefresh={() => {
        machinesApi.reload()
        departmentsApi.reload()
      }}
      refreshing={machinesApi.loading && !!machinesApi.data}
    >
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name, code, line or model" />
        <Chips options={deptChips} value={deptFilter} onChange={setDeptFilter} />
      </View>
      <DataState
        loading={machinesApi.loading}
        error={machinesApi.error}
        onRetry={machinesApi.reload}
        hasData={!!machinesApi.data}
        empty={!!machinesApi.data && filtered.length === 0}
        emptyText={machines.length === 0 ? 'No machines yet' : 'No machines match the filters'}
        emptyIcon="construct-outline"
      >
        <List>
          {filtered.map((m) => {
            const flag = machineFlag(m)
            return (
              <Row
                key={m.id}
                title={m.name}
                titleClassName={m.isActive ? '' : 'text-staff-muted'}
                subtitle={facts(m.code, m.departmentName, typesLabel(m.activityIds.length))}
                right={flag ? <Badge label={flag.label} tone={flag.tone} /> : undefined}
                onPress={() => push('machineDetail', { id: m.id })}
              />
            )
          })}
        </List>
      </DataState>
    </Screen>
  )
}

/** One machine: its details and check types; users with "manage" edit or delete it here. */
export const MachineDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('machines', 'manage')
  const machinesApi = useQuery<Machine[]>('/api/machines')
  const activitiesApi = useQuery<Activity[]>('/api/activities')
  const machine = (machinesApi.data ?? []).find((m) => m.id === params.id) ?? null
  const activityById = useMemo(() => new Map((activitiesApi.data ?? []).map((a) => [a.id, a])), [activitiesApi.data])

  const remove = async () => {
    if (machine && (await deleteMachine(machine, notify))) pop()
  }

  return (
    <Screen
      title="Machine"
      right={canEdit && machine ? { label: 'Edit', icon: 'create-outline', onPress: () => push('machineForm', { id: machine.id }) } : null}
      onRefresh={() => {
        machinesApi.reload()
        activitiesApi.reload()
      }}
      refreshing={machinesApi.loading && !!machinesApi.data}
    >
      <DataState
        loading={machinesApi.loading}
        error={machinesApi.error}
        onRetry={machinesApi.reload}
        hasData={!!machinesApi.data}
        empty={!!machinesApi.data && !machine}
        emptyText="This machine could not be found."
        emptyIcon="construct-outline"
      >
        {machine ? (
          <>
            <SummaryHeader
              title={machine.name}
              caption={facts(machine.code, machine.departmentName, typesLabel(machine.activityIds.length))}
              status={machineFlag(machine)}
            />

            <Section title="Details">
              <Card>
                <KV label="Department" value={machine.departmentName} />
                <KV label="Line" value={machine.line} />
                <KV label="Model" value={machine.model} />
                {machine.notes ? <KV stacked label="Notes" value={machine.notes} /> : null}
              </Card>
            </Section>

            <Section title="Check types">
              {machine.activityIds.length === 0 ? (
                <Empty text="No check types on this machine" icon="list-outline" />
              ) : (
                <List>
                  {machine.activityIds.map((id) => {
                    const a = activityById.get(id)
                    return (
                      <Row
                        key={id}
                        title={a?.name ?? (activitiesApi.loading ? 'Loading…' : 'Unknown check type')}
                        subtitle={a ? [a.code, a.departmentName].filter(Boolean).join(' · ') : null}
                        right={a && !a.isActive ? <Badge label="Inactive" tone="missed" /> : undefined}
                      />
                    )
                  })}
                </List>
              )}
            </Section>

            {can('checks') ? (
              <ActionGroup>
                <ActionItem label="View quality checks" onPress={() => push('checks', { machineId: machine.id })} />
              </ActionGroup>
            ) : null}
            {canEdit ? (
              <ActionGroup>
                <ActionItem label="Delete machine" tone="danger" onPress={remove} />
              </ActionGroup>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Add or edit a machine: details, status and the quality check types performed on it. */
const MachineForm: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { pop } = useStaff()
  const notify = useToast()
  const isNew = !params.id
  const machinesApi = useQuery<Machine[]>(isNew ? null : '/api/machines')
  const departmentsApi = useQuery<Department[]>('/api/departments')
  const activitiesApi = useQuery<Activity[]>('/api/activities')
  const editing = isNew ? null : ((machinesApi.data ?? []).find((m) => m.id === params.id) ?? null)

  const [form, setForm] = useState<FormState>(emptyForm)
  const [loaded, setLoaded] = useState(isNew)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (loaded || !editing) return
    setForm({
      name: editing.name,
      code: editing.code,
      departmentId: editing.departmentId ?? '',
      line: editing.line ?? '',
      model: editing.model ?? '',
      status: editing.status,
      notes: editing.notes ?? '',
      isActive: editing.isActive,
      activityIds: editing.activityIds
    })
    setLoaded(true)
  }, [editing, loaded])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
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
      if (isNew) {
        await api.post('/api/machines', body)
        notify('success', 'Machine created', body.name)
      } else {
        await api.put(`/api/machines/${params.id}`, body)
        notify('success', 'Machine updated', body.name)
      }
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const departments = departmentsApi.data ?? []
  const activities = activitiesApi.data ?? []
  // Active departments, plus the machine's current one if it has since been deactivated.
  const departmentOptions = departments
    .filter((d) => d.isActive || d.id === form.departmentId)
    .map((d) => ({ value: d.id, label: d.isActive ? d.name : `${d.name} (inactive)` }))
  const activityOptions = activities
    .filter((a) => a.isActive || form.activityIds.includes(a.id))
    .map((a) => ({
      value: a.id,
      label: a.isActive ? a.name : `${a.name} (inactive)`,
      detail: [a.departmentName, a.code].filter(Boolean).join(' · ')
    }))
  const pickerError = departmentsApi.error || activitiesApi.error

  return (
    <Screen
      title={isNew ? 'Add Machine' : 'Edit Machine'}
      footer={loaded ? <PrimaryButton label={isNew ? 'Create machine' : 'Save changes'} onPress={submit} loading={saving} /> : undefined}
    >
      <DataState
        loading={!isNew && machinesApi.loading}
        error={isNew ? null : machinesApi.error}
        onRetry={machinesApi.reload}
        hasData={loaded}
        empty={!isNew && !!machinesApi.data && !editing && !loaded}
        emptyText="This machine could not be found."
        emptyIcon="construct-outline"
      >
        {loaded ? (
          <>
            <FormError message={formError} />
            {pickerError ? <FormError message={`Could not load lists: ${pickerError}`} /> : null}

            <FormSection title="Details">
              <Input label="Name" required value={form.name} onChangeText={(v) => set('name', v)} placeholder="e.g. Printing Machine 03" maxLength={120} />
              <Input label="Code" required value={form.code} onChangeText={(v) => set('code', v)} placeholder="e.g. PRT-03" maxLength={40} autoCapitalize="characters" />
              <SelectField label="Department" value={form.departmentId} emptyLabel="No department" options={departmentOptions} onChange={(v) => set('departmentId', v)} />
              <Input label="Line" value={form.line} onChangeText={(v) => set('line', v)} placeholder="e.g. Line 2" maxLength={200} />
              <Input label="Model" value={form.model} onChangeText={(v) => set('model', v)} placeholder="e.g. Rotomec 8-Color" maxLength={200} />
              <Input label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} multiline maxLength={500} placeholder="Optional notes for supervisors" />
            </FormSection>

            <FormSection title="Status">
              <SelectField label="Status" value={form.status} options={STATUS_OPTIONS} onChange={(v) => v && set('status', v)} />
              <ToggleField label="Enabled" description="Disabled machines are hidden from workers and get no checks." value={form.isActive} onChange={(v) => set('isActive', v)} />
              {form.status !== 'ACTIVE' || !form.isActive ? (
                <Notice
                  tone="exception"
                  message={`${
                    form.isActive
                      ? `Machines in ${form.status === 'MAINTENANCE' ? 'Maintenance' : 'Idle'} get no scheduled checks.`
                      : 'Disabled machines get no scheduled checks.'
                  } Changing the status or enabled state removes its upcoming checks.`}
                />
              ) : null}
            </FormSection>

            <FormSection title="Check types" description="The quality checks performed on this machine. Set how often each runs on the Schedules page.">
              <MultiSelectField
                label={`Check types on this machine (${form.activityIds.length} selected)`}
                values={form.activityIds}
                options={activityOptions}
                onChange={(ids) => set('activityIds', ids)}
                placeholder={activitiesApi.loading ? 'Loading check types…' : activities.length === 0 ? 'No check types configured yet' : 'None selected'}
              />
            </FormSection>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Opened only with manage access; if that access is removed meanwhile, show why instead of a form the server refuses. */
export const MachineFormScreen: typeof MachineForm = (props) => {
  const { can } = useStaff()
  return can('machines', 'manage') ? <MachineForm {...props} /> : (
    <Screen title="Machine">
      <AccessDenied />
    </Screen>
  )
}

export const MACHINES_SCREENS = {
  machines: MachinesScreen,
  machineDetail: MachineDetailScreen,
  machineForm: MachineFormScreen
}
