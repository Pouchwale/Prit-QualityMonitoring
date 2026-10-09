import React, { useEffect, useMemo, useState } from 'react'
import { AppState, Platform, Text, View } from 'react-native'
import type { Access, ManagerRoleAccess, ModuleInfo, Permissions, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { formatDateTime } from '../format'
import {
  AccessDenied,
  Badge,
  Card,
  DataState,
  Empty,
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

/** View-only modules have nothing to manage: "Manage" is saved as "View" (the server does the same). */
const allowed = (module: ModuleInfo, level: Access): Access => (level === 'manage' && module.viewOnly ? 'view' : level)

/** No / View / Manage for one module. View-only modules cannot be set to Manage; nothing can change while saving. */
const levelOptions = (module: ModuleInfo, locked: boolean): Option<Access>[] => [
  { value: 'none', label: 'No access', disabled: locked },
  { value: 'view', label: 'View', disabled: locked },
  { value: 'manage', label: 'Manage', disabled: locked || !!module.viewOnly }
]

/** Shown instead of these screens to everyone but the Super Admin (the backend refuses them too). */
const SuperAdminOnly: React.FC<{ title?: string }> = ({ title = 'Manager Access' }) => (
  <Screen title={title}>
    <AccessDenied title="Only the Super Admin can manage Manager permissions." message="Admins can still add and edit Manager accounts in Workers & Users." />
  </Screen>
)

/**
 * Manager Access, for the Super Admin only: which modules Managers can view or manage. It is one set
 * for the whole Manager role, so every Manager has the same access, in every department. The backend
 * checks the same permissions on every request, so hiding a screen here is not the only protection.
 *
 * Below it, the Manager accounts it applies to. Admins also add and edit these accounts, in Workers &
 * Users, but they cannot change the permissions.
 */
export const ManagerAccessScreen: React.FC<{ params: Record<string, never> }> = () => {
  const { isSuperAdmin, push } = useStaff()
  const notify = useToast()
  const modulesApi = useQuery<ModuleInfo[]>(isSuperAdmin ? '/api/access/modules' : null)
  const roleApi = useQuery<ManagerRoleAccess>(isSuperAdmin ? '/api/access/roles/manager' : null)
  const [search, setSearch] = useState('')
  /**
   * Levels changed here and not saved yet. Every other module shows its saved level, so pulling to
   * refresh keeps these changes.
   */
  const [changes, setChanges] = useState<Partial<Permissions>>({})
  const [saving, setSaving] = useState(false)

  const modules = useMemo(() => modulesApi.data ?? [], [modulesApi.data])
  const managers = useMemo(() => roleApi.data?.managers ?? [], [roleApi.data])
  const saved = roleApi.data?.permissions ?? null
  const draft = useMemo(() => (saved ? { ...saved, ...changes } : null), [saved, changes])
  const changed = saved && draft ? modules.filter((m) => draft[m.key] !== saved[m.key]) : []
  const dirty = changed.length > 0
  const grantedCount = (p: Permissions) => modules.filter((m) => (p[m.key] ?? 'none') !== 'none').length

  const term = search.trim().toLowerCase()
  const rows = term ? managers.filter((m) => `${m.name} ${m.employeeId} ${m.designation ?? ''}`.toLowerCase().includes(term)) : managers

  if (!isSuperAdmin) return <SuperAdminOnly />

  const reload = () => {
    roleApi.reload()
    modulesApi.reload()
  }

  const setLevel = (module: ModuleInfo, level: Access) => setChanges((c) => ({ ...c, [module.key]: allowed(module, level) }))
  const setAll = (level: Access) => setChanges(Object.fromEntries(modules.map((m) => [m.key, allowed(m, level)])) as Partial<Permissions>)

  const save = async () => {
    if (!draft || !dirty) return
    setSaving(true)
    try {
      // Only the modules changed here are sent; the server keeps every other module as it is.
      const result = await api.put<{ permissions: Permissions }>('/api/access/roles/manager', {
        permissions: Object.fromEntries(changed.map((m) => [m.key, draft[m.key]]))
      })
      roleApi.setData((d) => (d ? { ...d, permissions: result.permissions } : d))
      setChanges({})
      notify('success', 'Permissions saved', 'Every Manager gets the new access on their next click.')
      // Also drops an older answer still on its way, so the screen cannot go back to the old permissions.
      roleApi.reload()
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  // Opening another screen drops unsaved changes, so it asks first.
  const open = async (name: string, params: Record<string, unknown>) => {
    if (dirty && !(await confirm('Discard changes?', 'You have unsaved permission changes. Discard them?', 'Discard', true))) return
    push(name, params)
  }
  const addManager = () => open('managerAccessForm', {})

  return (
    <Screen
      title="Manager Access"
      right={{ label: 'Add', icon: 'add', onPress: addManager }}
      onRefresh={reload}
      refreshing={(roleApi.loading || modulesApi.loading) && !!roleApi.data}
      footer={
        draft && modulesApi.data ? (
          <View className="gap-2">
            <Text className={`text-center text-[13px] ${dirty ? 'font-semibold text-due' : 'text-staff-muted'}`} accessibilityLiveRegion="polite">
              {dirty ? `Unsaved changes · ${changed.length} module${changed.length === 1 ? '' : 's'}` : `${grantedCount(draft)} of ${modules.length} modules granted`}
            </Text>
            <View className="flex-row gap-2">
              <SmallButton label="Undo" icon="arrow-undo-outline" onPress={() => setChanges({})} disabled={!dirty || saving} className="h-12 flex-1" />
              <View className="flex-[2]">
                <PrimaryButton label="Save permissions" onPress={save} loading={saving} disabled={!dirty} />
              </View>
            </View>
          </View>
        ) : undefined
      }
    >
      <Notice tone="accent" message="These permissions apply to every Manager. Changes apply on each Manager's next click." />
      <DataState
        loading={roleApi.loading || modulesApi.loading}
        error={roleApi.error || modulesApi.error}
        onRetry={reload}
        hasData={!!roleApi.data && !!modulesApi.data}
      >
        {saved && draft ? (
          <>
            <Section title="Manager permissions" detail={dirty ? 'You have unsaved changes' : `${grantedCount(saved)} of ${modules.length} modules granted`}>
              <Card>
                <View className="gap-2 px-4 pb-3 pt-4">
                  <Text className="text-[13px] font-medium text-staff-muted">Set all</Text>
                  <View className="flex-row flex-wrap gap-2">
                    <SmallButton label="No access" onPress={() => setAll('none')} disabled={saving} />
                    <SmallButton label="View all" onPress={() => setAll('view')} disabled={saving} />
                    <SmallButton label="Manage all" onPress={() => setAll('manage')} disabled={saving} />
                  </View>
                </View>
                {modules.map((m) => {
                  const level = draft[m.key] ?? 'none'
                  const isChanged = level !== (saved[m.key] ?? 'none')
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
                        {isChanged ? <Badge label="Changed" tone="due" /> : null}
                      </View>
                      <Segmented options={levelOptions(m, saving)} value={level} onChange={(l) => setLevel(m, l)} />
                    </View>
                  )
                })}
              </Card>
            </Section>

            <Section title={`Managers · ${managers.length}`}>
              {managers.length === 0 ? (
                <Empty
                  text="No managers yet. Add a manager to give them these permissions."
                  icon="people-outline"
                  action={{ label: 'Add manager', icon: 'add', onPress: addManager }}
                />
              ) : (
                <View className="gap-3">
                  {managers.length > 6 ? <SearchField value={search} onChangeText={setSearch} placeholder="Name, employee ID or designation" /> : null}
                  {rows.length === 0 ? (
                    <Notice title="No managers match this search." icon="search-outline" />
                  ) : (
                    <List>
                      {rows.map((m) => (
                        <PersonRow
                          key={m.id}
                          name={m.name}
                          muted={!m.isActive}
                          subtitle={facts(m.employeeId, m.designation)}
                          right={!m.isActive ? <Badge label="Deactivated" tone="missed" /> : undefined}
                          onPress={() => open('managerAccessDetail', { id: m.id })}
                        />
                      ))}
                    </List>
                  )}
                </View>
              )}
            </Section>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

/** One manager's account: details, edit, view password and activation. Their permissions are the Manager role's. */
export const ManagerAccessDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { isSuperAdmin, push } = useStaff()
  const notify = useToast()
  const roleApi = useQuery<ManagerRoleAccess>(isSuperAdmin ? '/api/access/roles/manager' : null)
  // Full account records, needed to edit a manager or activate them again.
  const accountsApi = useQuery<User[]>(isSuperAdmin ? '/api/users' : null, { role: 'MANAGER' })

  const selected = (roleApi.data?.managers ?? []).find((m) => m.id === params.id) ?? null
  const [toggling, setToggling] = useState(false)

  if (!isSuperAdmin) return <SuperAdminOnly title="Manager" />

  // Every Manager has the Manager role's permissions, so this one has them too.
  const levels: Access[] = roleApi.data ? Object.values(roleApi.data.permissions) : []
  const granted = levels.filter((a) => a !== 'none').length

  const reload = () => {
    roleApi.reload()
    accountsApi.reload()
  }

  const toggleActive = async () => {
    if (!selected) return
    const ok = selected.isActive
      ? await confirm('Deactivate manager?', `${selected.name} will be signed out now and cannot sign in until activated again.`, 'Deactivate', true)
      : await confirm('Activate manager?', `${selected.name} can sign in again, with the same access as every Manager.`, 'Activate')
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
          ...(record.workerQualityRole ? { workerQualityRole: record.workerQualityRole } : {}),
          designation: record.designation,
          departmentId: record.departmentId,
          shiftId: record.shiftId,
          phone: record.phone,
          isActive: true,
          appAccess: record.appAccess,
          machineIds: []
        })
        notify('success', 'Manager activated', `${selected.name} can sign in again, with the same access as every Manager.`)
      }
      await Promise.all([roleApi.reload(), accountsApi.reload()])
    } catch (err) {
      notify('error', 'Could not change the account', errorText(err))
    } finally {
      setToggling(false)
    }
  }

  return (
    <Screen
      title="Manager"
      right={selected ? { label: 'Edit account', icon: 'create-outline', onPress: () => push('managerAccessForm', { id: selected.id }), disabled: !accountsApi.data } : null}
      onRefresh={reload}
      refreshing={roleApi.loading && !!roleApi.data}
    >
      <DataState
        loading={roleApi.loading}
        error={roleApi.error}
        onRetry={reload}
        hasData={!!roleApi.data}
        empty={!!roleApi.data && !selected}
        emptyText="This manager could not be found."
        emptyIcon="person-outline"
      >
        {selected ? (
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

            <Notice
              icon="shield-checkmark-outline"
              title="Manager permissions"
              message={`The same for every Manager: ${granted} of ${levels.length} modules granted. Change them for all Managers on Manager Access.`}
            />

            <ActionGroup>
              <ActionItem
                label="View password"
                description="Super Admin only · recorded in the audit log"
                onPress={() => push('managerAccessPassword', { id: selected.id, name: selected.name, employeeId: selected.employeeId })}
              />
              {!selected.isActive ? (
                <ActionItem label="Activate" description="Lets them sign in again" onPress={toggleActive} disabled={toggling || !accountsApi.data} />
              ) : null}
            </ActionGroup>
            {selected.isActive ? (
              <ActionGroup>
                <ActionItem label="Deactivate" description="Signs them out and blocks sign-in" tone="danger" onPress={toggleActive} disabled={toggling} />
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

/**
 * Add a manager (no id) or edit a manager's account (id). Super Admin only here, like the rest of
 * Manager Access; Admins add and edit Manager accounts in Workers & Users.
 */
export const ManagerAccessFormScreen: React.FC<{ params: { id?: string } }> = ({ params }) => {
  const { isSuperAdmin, pop } = useStaff()
  const notify = useToast()
  const creating = !params?.id
  const accountsApi = useQuery<User[]>(isSuperAdmin && !creating ? '/api/users' : null, { role: 'MANAGER' })
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

  if (!isSuperAdmin) return <SuperAdminOnly title={creating ? 'Add Manager' : 'Edit Manager'} />

  const setForm = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => setFormState((f) => ({ ...f, [key]: value }))

  const save = async () => {
    if (!form.employeeId.trim() || !form.name.trim()) return setError('Employee ID and name are required')
    if (creating && form.password.length < 6) return setError('Password must be at least 6 characters')
    if (!creating && form.password && form.password.length < 6) return setError('New password must be at least 6 characters')
    if (!creating && !record) return

    // The stored fields this form does not show are sent unchanged.
    const base = record
      ? {
          departmentId: record.departmentId,
          shiftId: record.shiftId,
          phone: record.phone,
          ...(record.workerQualityRole ? { workerQualityRole: record.workerQualityRole } : {})
        }
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
      } else {
        const created = await api.post<User>('/api/users', body)
        notify('success', 'Manager created', `${created.name} gets the Manager permissions, like every Manager.`)
      }
      pop()
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
        <Input
          label={creating ? 'Password' : 'New password'}
          required={creating}
          hint={creating ? 'At least 6 characters' : 'Leave blank to keep the current password'}
          value={form.password}
          onChangeText={(v) => setForm('password', v)}
          secure
          autoCapitalize="none"
        />
        <ToggleField label="Active" description="Deactivated managers cannot sign in" value={form.isActive} onChange={(v) => setForm('isActive', v)} />
        <ToggleField
          label="Mobile app access"
          description="Can sign in to the mobile app, with the same module access as on the web"
          value={form.appAccess}
          onChange={(v) => setForm('appAccess', v)}
        />
      </FormSection>
      {creating ? <Notice tone="accent" message="A new manager gets the Manager permissions set on Manager Access, like every other Manager." /> : null}
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
