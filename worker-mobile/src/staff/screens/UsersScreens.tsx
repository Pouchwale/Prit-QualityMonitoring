import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Text, TextInput, View } from 'react-native'
import type { Department, Machine, Role, Shift, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { ROLE_LABEL, formatDateTime } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  Chips,
  DataState,
  FormError,
  FormSection,
  Input,
  KV,
  List,
  MultiSelectField,
  Notice,
  PrimaryButton,
  Screen,
  SearchField,
  Section,
  SelectField,
  SmallButton,
  ToggleField,
  confirm,
  useToast
} from '../ui'
import { ActionGroup, ActionItem, Initials, PersonRow, SummaryHeader, facts } from './adminParts'
import { formatClockRange } from '../../utils/datetime'

type RoleTab = '' | Role

const TABS: { value: RoleTab; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'WORKER', label: 'Workers' },
  { value: 'MANAGER', label: 'Managers' },
  { value: 'ADMIN', label: 'Admins' },
  { value: 'SUPER_ADMIN', label: 'Super Admins' }
]


/**
 * Accounts the signed-in user may create or edit. The backend enforces the same rule:
 * Super Admin → any; Admin → Managers and Workers; Manager with "Workers: manage" → Workers.
 */
function manageableRoles(role: Role | undefined): Role[] {
  if (role === 'SUPER_ADMIN') return ['WORKER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN']
  if (role === 'ADMIN') return ['WORKER', 'MANAGER']
  return ['WORKER']
}

const ROLE_HINT: Record<Role, string> = {
  WORKER: 'Uses the worker app on Android, iPhone or PC',
  MANAGER: 'Sees only the modules an Admin gives them in Manager Access',
  ADMIN: 'Full access, manages Managers, Workers and manager permissions',
  SUPER_ADMIN: 'Full access, including Admin accounts'
}

const machineCount = (n: number) => (n ? `${n} machine${n === 1 ? '' : 's'}` : 'No machines')

/** Name, initials, role and ID at the top of a user's screen; a status only when disabled. */
const UserSummary: React.FC<{ user: User; self: boolean }> = ({ user, self }) => (
  <SummaryHeader
    leading={<Initials name={user.name} size="lg" muted={!user.isActive} />}
    title={`${user.name}${self ? ' (you)' : ''}`}
    caption={facts(ROLE_LABEL[user.role], `ID ${user.employeeId}`, user.designation)}
    status={user.isActive ? null : { label: 'Disabled', tone: 'missed' }}
  />
)

interface FormState {
  employeeId: string
  name: string
  role: Role
  designation: string
  departmentId: string
  shiftId: string
  phone: string
  password: string
  isActive: boolean
  appAccess: boolean
  machineIds: string[]
}

const emptyForm: FormState = {
  employeeId: '',
  name: '',
  role: 'WORKER',
  designation: '',
  departmentId: '',
  shiftId: '',
  phone: '',
  password: '',
  isActive: true,
  appAccess: true,
  machineIds: []
}

/** The request body of PUT /api/users/:id for an unchanged user, with the given overrides. */
const userBody = (u: User, overrides: Partial<FormState> = {}) => {
  const role = overrides.role ?? u.role
  return {
    employeeId: u.employeeId,
    name: u.name,
    role,
    designation: u.designation,
    departmentId: u.departmentId,
    shiftId: u.shiftId,
    phone: u.phone,
    isActive: overrides.isActive ?? u.isActive,
    appAccess: overrides.appAccess ?? u.appAccess,
    machineIds: role === 'WORKER' ? u.machineIds : []
  }
}

/** Workers & Users: accounts for workers, managers and administrators. */
export const UsersScreen: React.FC<{ params?: Record<string, never> }> = () => {
  const { profile, can, push } = useStaff()
  const canEdit = can('workers', 'manage')
  const allowedRoles = manageableRoles(profile.role)
  const { data, error, loading, reload } = useQuery<User[]>('/api/users')
  const users = useMemo(() => data ?? [], [data])
  const [tab, setTab] = useState<RoleTab>('')
  const [search, setSearch] = useState('')

  const counts = useMemo(() => {
    const c: Record<Role, number> = { WORKER: 0, MANAGER: 0, ADMIN: 0, SUPER_ADMIN: 0 }
    for (const u of users) c[u.role]++
    return c
  }, [users])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (tab && u.role !== tab) return false
      if (!q) return true
      return [u.name, u.employeeId, u.designation, u.departmentName, u.shiftName, u.phone].some((v) => v?.toLowerCase().includes(q))
    })
  }, [users, tab, search])

  const tabs = TABS.filter((t) => t.value === '' || counts[t.value] > 0 || allowedRoles.includes(t.value)).map((t) => ({
    value: t.value,
    label: t.label,
    count: t.value === '' ? users.length : counts[t.value]
  }))

  return (
    <Screen
      title="Workers & Users"
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('userForm', { role: tab && allowedRoles.includes(tab) ? tab : 'WORKER' }) } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name, employee ID, department…" />
        <Chips options={tabs} value={tab} onChange={setTab} />
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && filtered.length === 0}
        emptyText={users.length === 0 ? 'No users yet' : 'No users match the filters'}
        emptyIcon={users.length === 0 ? 'people-outline' : 'search-outline'}
      >
        <List>
          {filtered.map((u) => (
            <PersonRow
              key={u.id}
              name={u.name}
              title={`${u.name}${u.id === profile.id ? ' (you)' : ''}`}
              muted={!u.isActive}
              subtitle={facts(u.employeeId, u.role === 'WORKER' ? machineCount(u.machineIds.length) : ROLE_LABEL[u.role], u.shiftName)}
              right={
                !u.isActive ? (
                  <Badge label="Disabled" tone="missed" />
                ) : u.role === 'WORKER' && u.machineIds.length === 0 ? (
                  <Badge label="No machines" tone="exception" />
                ) : undefined
              }
              onPress={() => push('userDetail', { id: u.id })}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** One account: details, and edit / view password / disable for those allowed. */
export const UserDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { profile, can, push } = useStaff()
  const notify = useToast()
  const canEdit = can('workers', 'manage')
  const { data, error, loading, reload } = useQuery<User[]>('/api/users')
  const machinesApi = useQuery<Machine[]>(can('machines') || can('workers', 'manage') ? '/api/machines' : null)
  const user = (data ?? []).find((u) => u.id === params.id) ?? null
  const [busy, setBusy] = useState(false)

  const self = user?.id === profile.id
  const canEditUser = !!user && canEdit && manageableRoles(profile.role).includes(user.role)
  // Only the Super Admin can view passwords.
  const canViewPasswords = canEdit && profile.role === 'SUPER_ADMIN'
  const machineNames = user ? (machinesApi.data ?? []).filter((m) => user.machineIds.includes(m.id)).map((m) => m.name) : []

  const disable = async () => {
    if (!user) return
    const ok = await confirm(
      'Disable user',
      `Disable ${user.name} (${user.employeeId})? They are signed out and can no longer sign in. Users are never deleted, so their check history is kept; you can re-enable them later from Edit.`,
      'Disable',
      true
    )
    if (!ok) return
    setBusy(true)
    try {
      await api.del(`/api/users/${user.id}`)
      notify('success', 'User disabled', `${user.name} can no longer sign in. Their check history is kept.`)
      reload()
    } catch (err) {
      notify('error', 'Could not disable user', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  // Same request as Edit → Active on → Save changes.
  const enable = async () => {
    if (!user) return
    setBusy(true)
    try {
      await api.put(`/api/users/${user.id}`, userBody(user, { isActive: true }))
      notify('success', 'User updated', user.name)
      reload()
    } catch (err) {
      notify('error', 'Could not update user', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const showAssignment = !!user && user.role === 'WORKER' && can('assignments')
  const showViewPassword = !!user && canViewPasswords
  const showStatusAction = !!user && canEdit && !self && canEditUser

  return (
    <Screen
      title="User"
      right={canEditUser ? { label: 'Edit', icon: 'create-outline', onPress: () => push('userForm', { id: params.id }) } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && !user} emptyText="User not found" emptyIcon="person-outline">
        {user ? (
          <>
            <UserSummary user={user} self={self} />

            <Section title="Details">
              <Card>
                <KV label="Employee ID" value={user.employeeId} />
                <KV label="Designation" value={user.designation} />
                <KV label="Department" value={user.departmentName} />
                <KV label="Shift" value={user.shiftName} />
                <KV label="Phone" value={user.phone} />
              </Card>
            </Section>

            <Section title="Sign-in">
              <Card>
                <KV
                  label="Mobile app"
                  value={<Text className={`text-[15px] font-medium ${user.appAccess ? 'text-success' : 'text-staff-muted'}`}>{user.appAccess ? 'Allowed' : 'Blocked'}</Text>}
                />
                <KV
                  label="Status"
                  value={<Text className={`text-[15px] font-medium ${user.isActive ? 'text-staff-ink' : 'text-missed'}`}>{user.isActive ? 'Active' : 'Disabled'}</Text>}
                />
                <KV label="Last login" value={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'} />
                <KV label="Created" value={formatDateTime(user.createdAt)} />
              </Card>
            </Section>

            {user.role === 'WORKER' ? (
              <Section title="Machines" detail={user.machineIds.length ? machineCount(user.machineIds.length) : undefined}>
                {user.machineIds.length === 0 ? (
                  <Notice tone="exception" title="None" message="This worker cannot see any checks" />
                ) : machineNames.length ? (
                  <Card>
                    <KV label="Assigned" value={machineNames.join(', ')} stacked />
                  </Card>
                ) : null}
              </Section>
            ) : null}

            {showAssignment || showViewPassword || (showStatusAction && !user.isActive) ? (
              <ActionGroup>
                {showAssignment ? (
                  <ActionItem label="Open Machine Assignment" description="Change which machines this worker checks" onPress={() => push('assignments')} />
                ) : null}
                {showViewPassword ? (
                  <ActionItem label="View password" description="Super Admin only · recorded in the audit log" onPress={() => push('userPassword', { id: user.id })} />
                ) : null}
                {showStatusAction && !user.isActive ? (
                  <ActionItem label="Enable" description="Lets them sign in again" onPress={enable} disabled={busy} accessibilityLabel="Enable" />
                ) : null}
              </ActionGroup>
            ) : null}

            {showStatusAction && user.isActive ? (
              <ActionGroup>
                <ActionItem
                  label="Disable"
                  description="Signs them out and blocks sign-in. History is kept."
                  tone="danger"
                  onPress={disable}
                  disabled={busy}
                  accessibilityLabel="Disable"
                />
              </ActionGroup>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** Add User (no id) or Edit User, with the same fields, rules and wording as the web form. */
const UserForm: React.FC<{ params: { id?: string; role?: Role } }> = ({ params }) => {
  const { profile, pop } = useStaff()
  const notify = useToast()
  const creating = !params.id
  const allowedRoles = manageableRoles(profile.role)
  const usersApi = useQuery<User[]>(creating ? null : '/api/users')
  const machinesApi = useQuery<Machine[]>('/api/machines')
  const departmentsApi = useQuery<Department[]>('/api/departments')
  const shiftsApi = useQuery<Shift[]>('/api/shifts')
  const editing = creating ? null : ((usersApi.data ?? []).find((u) => u.id === params.id) ?? null)

  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    role: params.role && allowedRoles.includes(params.role) ? params.role : 'WORKER'
  }))
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const loaded = useRef(false)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    if (!editing || loaded.current) return
    loaded.current = true
    setForm({
      employeeId: editing.employeeId,
      name: editing.name,
      role: editing.role,
      designation: editing.designation ?? '',
      departmentId: editing.departmentId ?? '',
      shiftId: editing.shiftId ?? '',
      phone: editing.phone ?? '',
      password: '',
      isActive: editing.isActive,
      appAccess: editing.appAccess,
      machineIds: editing.machineIds
    })
  }, [editing])

  const isSelf = !!editing && editing.id === profile.id
  // Only the Super Admin manages passwords: other users' here, their own in My Account.
  const canResetPassword = profile.role === 'SUPER_ADMIN' && !isSelf
  const canEditUser = creating || (!!editing && allowedRoles.includes(editing.role))

  const submit = async () => {
    if (!form.employeeId.trim() || !form.name.trim()) return setFormError('Employee ID and name are required')
    if (creating && form.password.length < 6) return setFormError('Password must be at least 6 characters')
    if (!creating && form.password && form.password.length < 6) return setFormError('New password must be at least 6 characters')

    setSaving(true)
    setFormError(null)
    try {
      const isWorker = form.role === 'WORKER'
      const body = {
        employeeId: form.employeeId.trim(),
        name: form.name.trim(),
        role: form.role,
        designation: form.designation.trim() || null,
        departmentId: form.departmentId || null,
        shiftId: form.shiftId || null,
        phone: form.phone.trim() || null,
        isActive: form.isActive,
        appAccess: form.appAccess,
        machineIds: isWorker ? form.machineIds : [],
        ...(form.password ? { password: form.password } : {})
      }
      if (creating) {
        await api.post('/api/users', body)
        notify('success', 'User created', `${body.name} can sign in with employee ID ${body.employeeId}.`)
      } else if (editing) {
        await api.put(`/api/users/${editing.id}`, body)
        notify('success', 'User updated', form.password ? `${body.name}. Password changed; they have been signed out.` : body.name)
      }
      setForm((f) => ({ ...f, password: '' }))
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const departments = (departmentsApi.data ?? []).filter((d) => d.isActive || d.id === form.departmentId)
  const shifts = (shiftsApi.data ?? []).filter((s) => s.isActive || s.id === form.shiftId)
  const machineOptions = (machinesApi.data ?? [])
    .filter((m) => m.isActive || form.machineIds.includes(m.id))
    .map((m) => ({
      value: m.id,
      label: m.isActive ? m.name : `${m.name} (disabled)`,
      detail: [m.departmentName, m.code].filter(Boolean).join(' · ')
    }))
  const pickerError = machinesApi.error || departmentsApi.error || shiftsApi.error
  const ready = creating || (!!editing && loaded.current)

  return (
    <Screen
      title={creating ? 'Add User' : 'Edit User'}
      subtitle={editing ? `${editing.name} · ${editing.employeeId}` : null}
      footer={ready && canEditUser ? <PrimaryButton label={creating ? 'Create user' : 'Save changes'} onPress={submit} loading={saving} /> : null}
    >
      <DataState
        loading={!creating && usersApi.loading}
        error={creating ? null : usersApi.error}
        onRetry={usersApi.reload}
        hasData={ready}
        empty={!creating && !!usersApi.data && !editing}
        emptyText="User not found"
        emptyIcon="person-outline"
      >
        {!canEditUser && editing ? (
          <AccessDenied title="Read only" message={`You cannot manage ${ROLE_LABEL[editing.role]} accounts`} />
        ) : (
          <>
            {formError || pickerError ? (
              <View className="gap-2">
                <FormError message={formError} />
                {pickerError ? <FormError message={`Could not load lists: ${pickerError}`} /> : null}
              </View>
            ) : null}

            <FormSection title="Basic details" description="Workers sign in to the mobile app with their employee ID">
              <Input
                label="Employee ID"
                required
                hint="Used to sign in"
                value={form.employeeId}
                onChangeText={(v) => set('employeeId', v)}
                placeholder="e.g. EMP-104"
                maxLength={40}
                autoCapitalize="characters"
              />
              <Input label="Full name" required value={form.name} onChangeText={(v) => set('name', v)} placeholder="e.g. Ravi Patel" maxLength={120} autoCapitalize="words" />
              <Input label="Phone" value={form.phone} onChangeText={(v) => set('phone', v)} placeholder="Optional" maxLength={30} keyboardType="phone-pad" />
            </FormSection>

            <FormSection title="Role & access">
              <SelectField
                label="Role"
                required
                hint={isSelf ? 'You cannot change your own role' : ROLE_HINT[form.role]}
                value={form.role}
                options={(isSelf ? [form.role] : allowedRoles).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                onChange={(v) => v && set('role', v)}
                disabled={isSelf || allowedRoles.length === 1}
              />
              {creating || canResetPassword ? (
                <Input
                  label={creating ? 'Password' : 'New password'}
                  required={creating}
                  hint={creating ? 'At least 6 characters' : 'Leave blank to keep the current password'}
                  value={form.password}
                  onChangeText={(v) => set('password', v)}
                  secure
                  autoCapitalize="none"
                />
              ) : (
                <Text className="text-[13px] leading-[18px] text-staff-muted">
                  {isSelf && profile.role === 'SUPER_ADMIN' ? 'To change your own password, use My Account.' : 'Only the Super Admin can change passwords.'}
                </Text>
              )}
              <ToggleField
                label="Active"
                description={isSelf ? 'You cannot disable your own account' : 'Disabled users cannot sign in'}
                value={form.isActive}
                onChange={(v) => set('isActive', v)}
                disabled={isSelf}
              />
              <ToggleField
                label="Mobile app access"
                description={form.role === 'WORKER' ? 'Can sign in to the mobile app to do quality checks' : 'Can sign in to the mobile app, with the same access as on the web'}
                value={form.appAccess}
                onChange={(v) => set('appAccess', v)}
                disabled={isSelf}
              />
            </FormSection>

            <FormSection title="Work">
              <Input
                label="Designation"
                hint="Shown as “Role” on the worker's mobile profile"
                value={form.designation}
                onChangeText={(v) => set('designation', v)}
                placeholder="e.g. Quality Inspector"
                maxLength={100}
              />
              <SelectField
                label="Department"
                value={form.departmentId}
                emptyLabel="No department"
                options={departments.map((d) => ({ value: d.id, label: d.isActive ? d.name : `${d.name} (inactive)` }))}
                onChange={(v) => set('departmentId', v)}
              />
              <SelectField
                label="Shift"
                value={form.shiftId}
                emptyLabel="No shift"
                options={shifts.map((s) => ({ value: s.id, label: `${s.name} (${formatClockRange(s.startTime, s.endTime)})${s.isActive ? '' : ' (inactive)'}` }))}
                onChange={(v) => set('shiftId', v)}
              />
            </FormSection>

            {form.role === 'WORKER' ? (
              <FormSection
                title="Machines"
                description="Schedules without an assigned worker show to every worker on the same shift who has access to that machine. Schedules assigned to a specific worker show only to that worker."
              >
                <MultiSelectField
                  label="Machines this worker can check"
                  hint={`${form.machineIds.length} selected`}
                  values={form.machineIds}
                  options={machineOptions}
                  onChange={(ids) => set('machineIds', ids)}
                  placeholder={machinesApi.loading ? 'Loading machines…' : machineOptions.length ? 'None selected' : 'No machines configured yet'}
                />
              </FormSection>
            ) : null}
          </>
        )}
      </DataState>
    </Screen>
  )
}

/**
 * Super Admin only: shows a user's password after the Super Admin confirms with their own
 * password. Each view is recorded in the audit log. The password is kept only in this screen's
 * state (never logged), so it is gone when the screen is left, and it is cleared when the app goes to the background.
 */
export const UserPasswordScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { profile, pop } = useStaff()
  const { data, error: loadError, loading: loadingUser, reload } = useQuery<User[]>('/api/users')
  const user = (data ?? []).find((u) => u.id === params.id) ?? null
  const [confirmPassword, setConfirmPassword] = useState('')
  const [result, setResult] = useState<{ available: boolean; password: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(true)

  // Forget the password when the app leaves the foreground; the Super Admin confirms again to see it.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        setResult(null)
        setConfirmPassword('')
        setVisible(true)
      }
    })
    return () => sub.remove()
  }, [])

  const reveal = async () => {
    if (!user || !confirmPassword) return
    setLoading(true)
    setError(null)
    try {
      setResult(await api.post<{ available: boolean; password: string | null }>(`/api/users/${user.id}/password/reveal`, { confirmPassword }))
      setConfirmPassword('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  const footer = !user ? null : result ? (
    <PrimaryButton label="Done" onPress={pop} />
  ) : (
    <PrimaryButton label="Show password" icon="eye-outline" onPress={reveal} loading={loading} disabled={!confirmPassword} />
  )

  return (
    <Screen title="View password" subtitle={user ? `${user.name} (${user.employeeId})` : null} footer={profile.role === 'SUPER_ADMIN' ? footer : null}>
      {profile.role !== 'SUPER_ADMIN' ? (
        <AccessDenied title="Not allowed" message="Only the Super Admin can view other users' passwords" />
      ) : (
        <DataState loading={loadingUser} error={loadError} onRetry={reload} hasData={!!data} empty={!!data && !user} emptyText="User not found" emptyIcon="person-outline">
          {!result ? (
            <FormSection title="Confirm it is you" description="Enter your own password to see this user's password.">
              <FormError message={error} />
              <Input
                label="Your password"
                required
                hint="Confirm it is you. This view is recorded in the audit log."
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secure
                autoCapitalize="none"
              />
            </FormSection>
          ) : result.available && result.password !== null ? (
            <Card className="gap-3 p-4">
              <Text className="text-[14px] font-semibold text-staff-ink2">Password</Text>
              <View className="rounded-xl bg-staff-fill">
                {visible ? (
                  <TextInput
                    value={result.password}
                    editable={false}
                    selectTextOnFocus
                    contextMenuHidden={false}
                    autoCorrect={false}
                    accessibilityLabel="Password"
                    className="px-4 py-3 font-mono text-[18px] text-staff-ink"
                  />
                ) : (
                  <Text className="px-4 py-3 font-mono text-[18px] text-staff-ink" accessibilityLabel="Password hidden">
                    {'•'.repeat(Math.max(8, result.password.length))}
                  </Text>
                )}
              </View>
              <View className="flex-row gap-2">
                <SmallButton
                  label={visible ? 'Hide password' : 'Show password'}
                  icon={visible ? 'eye-off-outline' : 'eye-outline'}
                  onPress={() => setVisible((v) => !v)}
                  className="flex-1"
                />
              </View>
              <Text className="text-[13px] leading-[18px] text-staff-muted">Long-press the password to copy it. Share it only with {user?.name}. It is hidden again when you close this.</Text>
            </Card>
          ) : (
            <Notice
              tone="exception"
              title="Not available"
              message="This password was set before passwords could be viewed, so only its one-way fingerprint is stored. To see it, set a new password with Edit → New password; from then on it can be viewed here."
            />
          )}
        </DataState>
      )}
    </Screen>
  )
}

/** Opened only with manage access; if that access is removed meanwhile, show why instead of a form the server refuses. */
export const UserFormScreen: typeof UserForm = (props) => {
  const { can, isAdmin } = useStaff()
  return (isAdmin || can('workers', 'manage')) ? <UserForm {...props} /> : (
    <Screen title="User">
      <AccessDenied />
    </Screen>
  )
}

export const USERS_SCREENS = {
  users: UsersScreen,
  userDetail: UserDetailScreen,
  userForm: UserFormScreen,
  userPassword: UserPasswordScreen
}
