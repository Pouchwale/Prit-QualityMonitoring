import React, { useEffect, useMemo, useState } from 'react'
import { AppState, Platform, Text, View } from 'react-native'
import type { Access, ManagerAccess, ModuleInfo, ModuleKey, Permissions, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { formatDateTime } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  DataState,
  FormError,
  FormSection,
  Input,
  List,
  Notice,
  PrimaryButton,
  Screen,
  SearchField,
  Section,
  Segmented,
  SmallButton,
  ToggleField,
  confirm,
  useToast,
  type Option
} from '../ui'
import { ActionGroup, ActionItem, Initials, PersonRow, SummaryHeader, facts } from './adminParts'

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

const sameAccess = (a: Permissions, b: Permissions) => (Object.keys(a) as ModuleKey[]).every((k) => a[k] === b[k])
const grantedCount = (p: Permissions) => Object.values(p).filter((a) => a !== 'none').length

/** No / View / Manage for one module. View-only modules cannot be set to Manage. */
const levelOptions = (module: ModuleInfo): Option<Access>[] => [
  { value: 'none', label: 'No access' },
  { value: 'view', label: 'View' },
  { value: 'manage', label: 'Manage', disabled: !!module.viewOnly }
]

/** Shown instead of the page to accounts that are not Admin or Super Admin (the backend refuses them too). */
const AdminOnly: React.FC = () => (
  <Screen title="Manager Access">
    <AccessDenied title="Only an Admin can do this" message="Manager access is managed by Admins and the Super Admin." />
  </Screen>
)

/**
 * Manager Access: Admins decide which modules each Manager can view or manage. The backend checks
 * the same permissions on every request, so hiding a screen here is not the only protection.
 */
export const ManagerAccessScreen: React.FC<{ params: Record<string, never> }> = () => {
  const { isAdmin, push } = useStaff()
  const modulesApi = useQuery<ModuleInfo[]>(isAdmin ? '/api/access/modules' : null)
  const managersApi = useQuery<ManagerAccess[]>(isAdmin ? '/api/access/managers' : null)
  const [search, setSearch] = useState('')

  const managers = useMemo(() => managersApi.data ?? [], [managersApi.data])
  const moduleCount = modulesApi.data?.length ?? 0
  const term = search.trim().toLowerCase()
  const rows = term ? managers.filter((m) => `${m.name} ${m.employeeId} ${m.designation ?? ''}`.toLowerCase().includes(term)) : managers

  if (!isAdmin) return <AdminOnly />

  const reload = () => {
    managersApi.reload()
    modulesApi.reload()
  }

  return (
    <Screen
      title="Manager Access"
      right={{ label: 'Add', icon: 'add', onPress: () => push('managerAccessForm', {}) }}
      onRefresh={reload}
      refreshing={(managersApi.loading || modulesApi.loading) && !!managersApi.data}
    >
      <Notice tone="accent" message="Choose which modules each Manager can view or manage. Changes apply on the manager's next click." />
      <DataState
        loading={managersApi.loading || modulesApi.loading}
        error={managersApi.error || modulesApi.error}
        onRetry={reload}
        hasData={!!managersApi.data && !!modulesApi.data}
        empty={!!managersApi.data && managers.length === 0}
        emptyText="No managers yet. Add a manager, then choose the modules they can use."
        emptyIcon="shield-checkmark-outline"
      >
        {managers.length > 6 ? <SearchField value={search} onChangeText={setSearch} placeholder="Name, employee ID or designation" /> : null}
        <Section title={`Managers · ${managers.length}`}>
          {rows.length === 0 ? (
            <Notice title="No managers match this search." icon="search-outline" />
          ) : (
            <List>
              {rows.map((m) => {
                const granted = grantedCount(m.permissions)
                return (
                  <PersonRow
                    key={m.id}
                    name={m.name}
                    muted={!m.isActive}
                    subtitle={facts(m.employeeId, `${granted} of ${moduleCount} modules granted`)}
                    right={
                      !m.isActive ? <Badge label="Deactivated" tone="missed" /> : granted === 0 ? <Badge label="No access" tone="neutral" /> : undefined
                    }
                    onPress={() => push('managerAccessDetail', { id: m.id })}
                  />
                )
              })}
            </List>
          )}
        </Section>
      </DataState>
    </Screen>
  )
}

/** One manager: per-module permissions, account actions and activation. */
export const ManagerAccessDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { isAdmin, isSuperAdmin, push, pop } = useStaff()
  const notify = useToast()
  const modulesApi = useQuery<ModuleInfo[]>(isAdmin ? '/api/access/modules' : null)
  const managersApi = useQuery<ManagerAccess[]>(isAdmin ? '/api/access/managers' : null)
  // Full account records, needed to activate a manager again.
  const accountsApi = useQuery<User[]>(isAdmin ? '/api/users' : null, { role: 'MANAGER' })

  const modules = useMemo(() => modulesApi.data ?? [], [modulesApi.data])
  const selected = (managersApi.data ?? []).find((m) => m.id === params.id) ?? null
  const [draft, setDraft] = useState<Permissions | null>(null)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)

  useEffect(() => {
    setDraft(selected ? { ...selected.permissions } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managersApi.data])

  if (!isAdmin) return <AdminOnly />

  const dirty = !!(selected && draft && !sameAccess(selected.permissions, draft))
  const changedCount = selected && draft ? modules.filter((m) => draft[m.key] !== selected.permissions[m.key]).length : 0

  const setLevel = (module: ModuleInfo, level: Access) => {
    if (!draft) return
    setDraft({ ...draft, [module.key]: level === 'manage' && module.viewOnly ? 'view' : level })
  }
  const setAll = (level: Access) => {
    if (!draft) return
    setDraft(Object.fromEntries(modules.map((m) => [m.key, level === 'manage' && m.viewOnly ? 'view' : level])) as Permissions)
  }

  const reload = () => {
    modulesApi.reload()
    managersApi.reload()
    accountsApi.reload()
  }

  const save = async () => {
    if (!selected || !draft) return
    setSaving(true)
    try {
      await api.put(`/api/access/managers/${selected.id}`, { permissions: draft })
      notify('success', 'Permissions saved', `${selected.name} gets the new access on their next click.`)
      pop()
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async () => {
    if (!selected) return
    const ok = selected.isActive
      ? await confirm(
          'Deactivate manager?',
          `${selected.name} will be signed out now and cannot sign in until activated again. Their permissions are kept.`,
          'Deactivate',
          true
        )
      : await confirm('Activate manager?', `${selected.name} can sign in again with the permissions they had.`, 'Activate')
    if (!ok) return
    const record = accountsApi.data?.find((u) => u.id === selected.id)
    setToggling(true)
    try {
      if (selected.isActive) {
        await api.del(`/api/users/${selected.id}`)
        notify('success', 'Manager deactivated', `${selected.name} is signed out and cannot sign in.`)
      } else if (record) {
        await api.put(`/api/users/${selected.id}`, {
          employeeId: record.employeeId,
          name: record.name,
          role: 'MANAGER',
          designation: record.designation,
          departmentId: record.departmentId,
          shiftId: record.shiftId,
          phone: record.phone,
          isActive: true,
          appAccess: record.appAccess,
          machineIds: []
        })
        notify('success', 'Manager activated', `${selected.name} can sign in again with the same access.`)
      }
      await Promise.all([managersApi.reload(), accountsApi.reload()])
    } catch (err) {
      notify('error', 'Could not change the account', errorText(err))
    } finally {
      setToggling(false)
    }
  }

  const discard = async () => {
    if (dirty && !(await confirm('Discard changes?', 'You have unsaved permission changes. Discard them?', 'Discard', true))) return
    pop()
  }

  const headerActions = [
    ...(dirty ? [{ label: 'Discard', onPress: discard, tone: 'danger' as const }] : []),
    ...(selected ? [{ label: 'Edit account', icon: 'create-outline' as const, onPress: () => push('managerAccessForm', { id: selected.id }), disabled: !accountsApi.data }] : [])
  ]

  return (
    <Screen
      title="Manager"
      right={headerActions.length ? headerActions : null}
      onRefresh={reload}
      refreshing={managersApi.loading && !!managersApi.data}
      footer={
        selected && draft ? (
          <View className="gap-2">
            <Text className={`text-center text-[13px] ${dirty ? 'font-semibold text-due' : 'text-staff-muted'}`} accessibilityLiveRegion="polite">
              {dirty
                ? `Unsaved changes · ${changedCount} module${changedCount === 1 ? '' : 's'}`
                : `${grantedCount(selected.permissions)} of ${modules.length} modules granted`}
            </Text>
            <View className="flex-row gap-2">
              <SmallButton label="Undo" icon="arrow-undo-outline" onPress={() => setDraft({ ...selected.permissions })} disabled={!dirty || saving} className="h-12 flex-1" />
              <View className="flex-[2]">
                <PrimaryButton label="Save permissions" onPress={save} loading={saving} disabled={!dirty} />
              </View>
            </View>
          </View>
        ) : undefined
      }
    >
      <DataState
        loading={managersApi.loading || modulesApi.loading}
        error={managersApi.error || modulesApi.error}
        onRetry={reload}
        hasData={!!managersApi.data && !!modulesApi.data}
        empty={!!managersApi.data && !selected}
        emptyText="This manager could not be found."
        emptyIcon="person-outline"
      >
        {selected && draft ? (
          <>
            <SummaryHeader
              leading={<Initials name={selected.name} size="lg" muted={!selected.isActive} />}
              title={selected.name}
              caption={facts(
                'Manager',
                selected.employeeId,
                selected.designation,
                `Last sign-in ${selected.lastLoginAt ? formatDateTime(selected.lastLoginAt) : 'never'}`
              )}
              status={selected.isActive ? null : { label: 'Deactivated', tone: 'missed' }}
            />

            <Section title="Permissions" detail={dirty ? 'You have unsaved changes' : `${grantedCount(selected.permissions)} of ${modules.length} modules granted`}>
              <Card>
                <View className="gap-2 px-4 pb-3 pt-4">
                  <Text className="text-[13px] font-medium text-staff-muted">Set all</Text>
                  <View className="flex-row flex-wrap gap-2">
                    <SmallButton label="No access" onPress={() => setAll('none')} />
                    <SmallButton label="View all" onPress={() => setAll('view')} />
                    <SmallButton label="Manage all" onPress={() => setAll('manage')} />
                  </View>
                </View>
                {modules.map((m) => {
                  const level = draft[m.key]
                  const changed = level !== selected.permissions[m.key]
                  return (
                    <View key={m.key} className="gap-2.5 border-t border-staff-line px-4 py-3">
                      <View className="flex-row items-start gap-2">
                        <View className="flex-1">
                          <Text className="text-[15px] font-semibold leading-[20px] text-staff-ink">{m.label}</Text>
                          <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">
                            {m.description}
                            {m.viewOnly ? ' · view only' : ''}
                          </Text>
                        </View>
                        {changed ? <Badge label="Changed" tone="due" /> : null}
                      </View>
                      <Segmented options={levelOptions(m)} value={level} onChange={(l) => setLevel(m, l)} />
                    </View>
                  )
                })}
              </Card>
            </Section>

            {isSuperAdmin || !selected.isActive ? (
              <ActionGroup>
                {isSuperAdmin ? (
                  <ActionItem
                    label="View password"
                    description="Super Admin only · recorded in the audit log"
                    onPress={() => push('managerAccessPassword', { id: selected.id, name: selected.name, employeeId: selected.employeeId })}
                  />
                ) : null}
                {!selected.isActive ? (
                  <ActionItem
                    label="Activate"
                    description="Lets them sign in again with the same access"
                    onPress={toggleActive}
                    disabled={toggling || !accountsApi.data}
                  />
                ) : null}
              </ActionGroup>
            ) : null}
            {selected.isActive ? (
              <ActionGroup>
                <ActionItem
                  label="Deactivate"
                  description="Signs them out. Their permissions are kept."
                  tone="danger"
                  onPress={toggleActive}
                  disabled={toggling}
                />
              </ActionGroup>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

interface AccountForm {
  employeeId: string
  name: string
  designation: string
  password: string
  isActive: boolean
  /** Can sign in to the mobile app. */
  appAccess: boolean
}

const EMPTY_FORM: AccountForm = { employeeId: '', name: '', designation: '', password: '', isActive: true, appAccess: false }

/** Add a manager (no id) or edit a manager's account (id). */
export const ManagerAccessFormScreen: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { isAdmin, isSuperAdmin, pop, replace } = useStaff()
  const notify = useToast()
  const creating = !params?.id
  // Only the Super Admin may reset another user's password.
  const canResetPassword = isSuperAdmin
  const accountsApi = useQuery<User[]>(isAdmin && !creating ? '/api/users' : null, { role: 'MANAGER' })
  const record = creating ? null : ((accountsApi.data ?? []).find((u) => u.id === params?.id) ?? null)

  const [form, setFormState] = useState<AccountForm>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (record) {
      setFormState({ employeeId: record.employeeId, name: record.name, designation: record.designation ?? '', password: '', isActive: record.isActive, appAccess: record.appAccess })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id])

  if (!isAdmin) return <AdminOnly />

  const setForm = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => setFormState((f) => ({ ...f, [key]: value }))

  const save = async () => {
    if (!form.employeeId.trim() || !form.name.trim()) return setError('Employee ID and name are required')
    if (creating && form.password.length < 6) return setError('Password must be at least 6 characters')
    if (!creating && form.password && form.password.length < 6) return setError('New password must be at least 6 characters')
    if (!creating && !record) return

    const base = record
      ? { departmentId: record.departmentId, shiftId: record.shiftId, phone: record.phone }
      : { departmentId: null, shiftId: null, phone: null }
    const body = {
      ...base,
      employeeId: form.employeeId.trim(),
      name: form.name.trim(),
      designation: form.designation.trim() || null,
      role: 'MANAGER',
      isActive: form.isActive,
      appAccess: form.appAccess,
      machineIds: [],
      ...(form.password ? { password: form.password } : {})
    }

    setSaving(true)
    setError(null)
    try {
      if (record) {
        await api.put(`/api/users/${record.id}`, body)
        notify('success', 'Manager updated', body.name)
        pop()
      } else {
        const created = await api.post<User>('/api/users', body)
        notify('success', 'Manager created', `${created.name} has no access yet. Choose their modules and save.`)
        replace('managerAccessDetail', { id: created.id })
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const fields = (
    <>
      <FormError message={error} />
      <FormSection title="Account details" description="Managers sign in with their employee ID">
        <Input label="Employee ID" required hint="Used to sign in" value={form.employeeId} onChangeText={(v) => setForm('employeeId', v)} maxLength={40} autoCapitalize="none" />
        <Input label="Full name" required value={form.name} onChangeText={(v) => setForm('name', v)} maxLength={120} autoCapitalize="words" />
        <Input label="Designation" value={form.designation} onChangeText={(v) => setForm('designation', v)} placeholder="e.g. Production Manager" maxLength={100} />
      </FormSection>
      <FormSection title="Sign-in & access">
        {creating || canResetPassword ? (
          <Input
            label={creating ? 'Password' : 'New password'}
            required={creating}
            hint={creating ? 'At least 6 characters' : 'Leave blank to keep the current password'}
            value={form.password}
            onChangeText={(v) => setForm('password', v)}
            secure
            autoCapitalize="none"
          />
        ) : (
          <Text className="text-[13px] leading-[18px] text-staff-muted">Only the Super Admin can change this manager's password.</Text>
        )}
        <ToggleField label="Active" description="Deactivated managers cannot sign in" value={form.isActive} onChange={(v) => setForm('isActive', v)} />
        <ToggleField
          label="Mobile app access"
          description="Can sign in to the mobile app, with the same module access as on the web"
          value={form.appAccess}
          onChange={(v) => setForm('appAccess', v)}
        />
      </FormSection>
      {creating ? <Notice tone="accent" message="A new manager has no access until you choose their modules and save." /> : null}
    </>
  )

  return (
    <Screen
      title={creating ? 'Add Manager' : 'Edit Manager'}
      subtitle={record ? `${record.name} · ${record.employeeId}` : null}
      footer={creating || record ? <PrimaryButton label={creating ? 'Create manager' : 'Save changes'} onPress={save} loading={saving} /> : undefined}
    >
      {creating ? (
        fields
      ) : (
        <DataState
          loading={accountsApi.loading}
          error={accountsApi.error}
          onRetry={accountsApi.reload}
          hasData={!!accountsApi.data}
          empty={!!accountsApi.data && !record}
          emptyText="This manager could not be found."
          emptyIcon="person-outline"
        >
          {fields}
        </DataState>
      )}
    </Screen>
  )
}

/**
 * Super Admin only: shows a user's password after the Super Admin confirms with their own
 * password. Each view is recorded in the audit log. The password is cleared when leaving.
 */
export const ManagerAccessPasswordScreen: React.FC<{ params: { id: string; name: string; employeeId: string } }> = ({ params }) => {
  const { isSuperAdmin, pop } = useStaff()
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
    if (!confirmPassword) return
    setLoading(true)
    setError(null)
    try {
      setResult(await api.post<{ available: boolean; password: string | null }>(`/api/users/${params.id}/password/reveal`, { confirmPassword }))
      setConfirmPassword('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen
      title="View password"
      subtitle={`${params.name} (${params.employeeId})`}
      footer={
        !isSuperAdmin ? undefined : result ? (
          <PrimaryButton label="Done" onPress={pop} />
        ) : (
          <PrimaryButton label="Show password" icon="eye-outline" onPress={reveal} loading={loading} disabled={!confirmPassword} />
        )
      }
    >
      {!isSuperAdmin ? (
        <AccessDenied title="Only the Super Admin can view other users' passwords" message={null} />
      ) : !result ? (
        <FormSection title="Confirm it is you" description="Enter your own password to see this manager's password.">
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
          <Text
            selectable
            accessibilityLiveRegion="polite"
            className="rounded-xl bg-staff-fill px-4 py-3 text-[17px] text-staff-ink"
            style={{ fontFamily: MONO }}
          >
            {visible ? result.password : '•'.repeat(Math.max(8, result.password.length))}
          </Text>
          <SmallButton label={visible ? 'Hide password' : 'Show password'} icon={visible ? 'eye-off-outline' : 'eye-outline'} onPress={() => setVisible((v) => !v)} />
          <Text className="text-[13px] leading-[18px] text-staff-muted">
            Long-press the password to copy it. Share it only with {params.name}. It is hidden again when you leave this screen.
          </Text>
        </Card>
      ) : (
        <Notice
          tone="exception"
          title="Not available"
          message="This password was set before passwords could be viewed, so only its one-way fingerprint is stored. To see it, set a new password with Edit account → New password; from then on it can be viewed here."
        />
      )}
    </Screen>
  )
}

export const MANAGER_ACCESS_SCREENS = {
  managerAccess: ManagerAccessScreen,
  managerAccessDetail: ManagerAccessDetailScreen,
  managerAccessForm: ManagerAccessFormScreen,
  managerAccessPassword: ManagerAccessPasswordScreen
}
