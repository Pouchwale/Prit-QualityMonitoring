import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertOctagon,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarOff,
  Check,
  ClipboardCheck,
  Clock3,
  Cpu,
  Download,
  Eye,
  FileSpreadsheet,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Users,
  Workflow,
  X
} from 'lucide-react'
import type { Access, ManagerAccount, ManagerRoleAccess, ModuleInfo, ModuleKey, Permissions, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { formatDateTime } from '../../lib/format'
import { useAuth } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { RevealPasswordModal } from './RevealPasswordModal'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'
import { Pill, UserAvatar } from '../../components/ui/Chips'

/** The three access levels; `on` is the look of the selected one (the text always says which). */
const LEVELS: { value: Access; label: string; short: string; icon: React.ReactNode; on: string }[] = [
  { value: 'none', label: 'No access', short: 'None', icon: <X className="w-3 h-3" aria-hidden />, on: 'bg-white text-ink ring-line-strong' },
  { value: 'view', label: 'View', short: 'View', icon: <Eye className="w-3 h-3" aria-hidden />, on: 'bg-due-bg text-due ring-due-line' },
  { value: 'manage', label: 'Manage', short: 'Manage', icon: <Check className="w-3 h-3" aria-hidden />, on: 'bg-success-bg text-success ring-success-line' }
]

/** The same icons as the sidebar, so a module is easy to find in the list. */
const MODULE_ICON: Partial<Record<ModuleKey, React.ReactNode>> = {
  dashboard: <LayoutDashboard className="w-4 h-4" />,
  checks: <ClipboardCheck className="w-4 h-4" />,
  jobs: <Briefcase className="w-4 h-4" />,
  exceptions: <AlertOctagon className="w-4 h-4" />,
  reports: <FileSpreadsheet className="w-4 h-4" />,
  export: <Download className="w-4 h-4" />,
  performance: <Gauge className="w-4 h-4" />,
  machines: <Cpu className="w-4 h-4" />,
  parameters: <SlidersHorizontal className="w-4 h-4" />,
  activities: <Workflow className="w-4 h-4" />,
  schedules: <CalendarClock className="w-4 h-4" />,
  calendar: <CalendarOff className="w-4 h-4" />,
  shifts: <Clock3 className="w-4 h-4" />,
  departments: <Building2 className="w-4 h-4" />,
  workers: <Users className="w-4 h-4" />,
  audit_logs: <History className="w-4 h-4" />,
  settings: <Settings className="w-4 h-4" />
}

/** View-only modules have nothing to manage: "Manage" is saved as "View" (the server does the same). */
const allowed = (module: ModuleInfo, level: Access): Access => (level === 'manage' && module.viewOnly ? 'view' : level)

interface AccountForm {
  employeeId: string
  name: string
  designation: string
  password: string
  isActive: boolean
  /** Can sign in to the mobile app. */
  appAccess: boolean
}

/**
 * Super Admin only: which modules Managers can view or manage. It is one set for the whole Manager
 * role, so every Manager has the same access, in every department. The backend checks the same
 * permissions on every request, so hiding a page here is not the only protection.
 *
 * Below it, the Manager accounts it applies to. Admins also create and edit these accounts, on
 * Workers & Users, but they cannot change the permissions.
 */
export const ManagerAccessPage: React.FC = () => {
  const notify = useToast()
  // Only the Super Admin may view or reset another user's password.
  const { isSuperAdmin } = useAuth()
  const modulesApi = useApi<ModuleInfo[]>('/api/access/modules')
  const roleApi = useApi<ManagerRoleAccess>('/api/access/roles/manager')
  // Full account records, needed to edit a manager's details.
  const accountsApi = useApi<User[]>('/api/users', { role: 'MANAGER' })

  const modules = useMemo(() => modulesApi.data ?? [], [modulesApi.data])
  const managers = useMemo(() => roleApi.data?.managers ?? [], [roleApi.data])
  const saved = roleApi.data?.permissions ?? null

  /**
   * Levels changed on this page and not saved yet. Every other module shows its saved level, so
   * reloading the page data (e.g. after a Manager account is added) keeps these changes.
   */
  const [changes, setChanges] = useState<Partial<Permissions>>({})
  const [saving, setSaving] = useState(false)
  const [account, setAccount] = useState<{ editing: User | 'new'; form: AccountForm } | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [savingAccount, setSavingAccount] = useState(false)
  const [toggling, setToggling] = useState<ManagerAccount | null>(null)
  const [revealing, setRevealing] = useState<ManagerAccount | null>(null)

  const draft = useMemo(() => (saved ? { ...saved, ...changes } : null), [saved, changes])
  const changed = useMemo(() => (saved && draft ? modules.filter((m) => draft[m.key] !== saved[m.key]) : []), [modules, saved, draft])
  const dirty = changed.length > 0
  const grantedCount = (p: Permissions) => modules.filter((m) => (p[m.key] ?? 'none') !== 'none').length

  // Closing or reloading the browser tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = true // older browsers need this as well
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const setLevel = (module: ModuleInfo, level: Access) => setChanges((c) => ({ ...c, [module.key]: allowed(module, level) }))
  const setAll = (level: Access) => setChanges(Object.fromEntries(modules.map((m) => [m.key, allowed(m, level)])))

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
      // Also drops an older answer still on its way, so the page cannot go back to the old permissions.
      roleApi.reload()
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const openNewManager = () => {
    setAccountError(null)
    setAccount({ editing: 'new', form: { employeeId: '', name: '', designation: '', password: '', isActive: true, appAccess: false } })
  }
  const openEditManager = (m: ManagerAccount) => {
    const record = accountsApi.data?.find((u) => u.id === m.id)
    if (!record) return
    setAccountError(null)
    setAccount({
      editing: record,
      form: { employeeId: record.employeeId, name: record.name, designation: record.designation ?? '', password: '', isActive: record.isActive, appAccess: record.appAccess }
    })
  }

  const saveAccount = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!account) return
    const { form, editing } = account
    const creating = editing === 'new'
    if (!form.employeeId.trim() || !form.name.trim()) return setAccountError('Employee ID and name are required')
    if (creating && form.password.length < 6) return setAccountError('Password must be at least 6 characters')
    if (!creating && form.password && form.password.length < 6) return setAccountError('New password must be at least 6 characters')

    const base = creating
      ? { departmentId: null, shiftId: null, phone: null }
      : { departmentId: editing.departmentId, shiftId: editing.shiftId, phone: editing.phone }
    const body = {
      ...base,
      employeeId: form.employeeId.trim(),
      name: form.name.trim(),
      designation: form.designation.trim() || null,
      role: 'MANAGER',
      isActive: form.isActive,
      appAccess: form.appAccess,
      ...(form.password ? { password: form.password } : {})
    }

    setSavingAccount(true)
    setAccountError(null)
    try {
      if (creating) {
        const created = await api.post<User>('/api/users', body)
        notify('success', 'Manager created', `${created.name} gets the Manager permissions set on this page.`)
      } else {
        await api.put(`/api/users/${editing.id}`, body)
        notify('success', 'Manager updated', body.name)
      }
      setAccount(null)
      await Promise.all([roleApi.reload(), accountsApi.reload()])
    } catch (err) {
      setAccountError(errorText(err))
    } finally {
      setSavingAccount(false)
    }
  }

  const toggleActive = async () => {
    if (!toggling) return
    const record = accountsApi.data?.find((u) => u.id === toggling.id)
    try {
      if (toggling.isActive) {
        await api.del(`/api/users/${toggling.id}`)
        notify('success', 'Manager deactivated', `${toggling.name} is signed out and cannot sign in.`)
      } else if (record) {
        await api.put(`/api/users/${toggling.id}`, {
          employeeId: record.employeeId,
          name: record.name,
          role: 'MANAGER',
          designation: record.designation,
          departmentId: record.departmentId,
          shiftId: record.shiftId,
          phone: record.phone,
          isActive: true,
          appAccess: record.appAccess
        })
        notify('success', 'Manager activated', `${toggling.name} can sign in again, with the same access as every Manager.`)
      }
      await Promise.all([roleApi.reload(), accountsApi.reload()])
    } catch (err) {
      notify('error', 'Could not change the account', errorText(err))
    }
  }

  const setForm = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) =>
    setAccount((a) => (a ? { ...a, form: { ...a.form, [key]: value } } : a))

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldCheck className="w-4.5 h-4.5" />}
        title="Manager Access"
        description={roleApi.data ? `${grantedCount(roleApi.data.permissions)} of ${modules.length} modules granted · ${managers.length} ${managers.length === 1 ? 'manager' : 'managers'}` : 'What Managers can view or manage'}
        info="Choose which modules Managers can view or manage. It is one set for the whole Manager role, the same in every department, and changes apply on each Manager's next click. Admins also create and edit Manager accounts on Workers & Users, but only the Super Admin can change these permissions."
        actions={
          <Button size="sm" variant="primary" onClick={openNewManager} icon={<Plus className="w-3.5 h-3.5" />}>
            Add Manager
          </Button>
        }
      />

      <DataState
        loading={roleApi.loading || modulesApi.loading}
        error={roleApi.error || modulesApi.error}
        onRetry={() => {
          roleApi.reload()
          modulesApi.reload()
        }}
        // Once loaded, the page stays on screen while it reloads (e.g. after an account change).
        empty={roleApi.data && modulesApi.data ? false : undefined}
      >
        {saved && draft && (
          <div className="space-y-5">
            {/* Permissions of the Manager role. overflow-clip (not hidden) keeps the Save bar in view while scrolling. */}
            <Card className="overflow-clip" aria-label="Manager permissions">
              <CardHeader
                icon={<ShieldCheck className="w-4 h-4" />}
                title="Manager permissions"
                subtitle="Applies to every Manager"
                info="These permissions apply to every Manager. Only the Super Admin can change them. The server checks the same permissions on every request."
                actions={
                  <div role="group" aria-label="Set all modules" className="hidden sm:flex items-center gap-1">
                    <span className="text-[11.5px] text-ink-muted mr-1">Set all</span>
                    {LEVELS.map((l) => (
                      <Button key={l.value} size="sm" variant="ghost" onClick={() => setAll(l.value)} disabled={saving} icon={l.icon} aria-label={`Set all modules to ${l.label}`}>
                        {l.short}
                      </Button>
                    ))}
                  </div>
                }
              />
              {/* Phones: the Set all buttons get their own row. */}
              <div role="group" aria-label="Set all modules" className="sm:hidden flex flex-wrap items-center gap-1 px-3 py-2 border-b border-line">
                <span className="text-[11.5px] text-ink-muted mr-1">Set all</span>
                {LEVELS.map((l) => (
                  <Button key={l.value} size="sm" variant="ghost" onClick={() => setAll(l.value)} disabled={saving} icon={l.icon} aria-label={`Set all modules to ${l.label}`}>
                    {l.short}
                  </Button>
                ))}
              </div>

              <ul className="p-3 grid grid-cols-1 xl:grid-cols-2 gap-2.5">
                {modules.map((m) => {
                  const level = draft[m.key]
                  const isChanged = level !== saved[m.key]
                  return (
                    <li
                      key={m.key}
                      className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${isChanged ? 'border-accent-line bg-accent-soft/40' : 'border-line bg-white'}`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <span className="w-8 h-8 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
                          {MODULE_ICON[m.key] ?? <LayoutGrid className="w-4 h-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[13px] font-semibold text-ink">{m.label}</span>
                            {m.viewOnly && <span className="text-[11px] text-ink-muted">· view only</span>}
                            {isChanged && (
                              <span className="h-[18px] px-1.5 inline-flex items-center rounded-full bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent-line text-[11px] font-semibold">
                                Changed
                              </span>
                            )}
                          </div>
                          <p className="text-[11.5px] text-ink-muted leading-snug line-clamp-2" title={m.description}>
                            {m.description}
                          </p>
                        </div>
                      </div>
                      <div role="radiogroup" aria-label={`${m.label} access`} className="grid grid-cols-3 gap-0.5 p-0.5 rounded-md bg-subtle border border-line sm:w-[228px] shrink-0">
                        {LEVELS.map((l) => {
                          const disabled = l.value === 'manage' && m.viewOnly
                          const on = level === l.value
                          return (
                            <button
                              key={l.value}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              disabled={disabled || saving}
                              onClick={() => setLevel(m, l.value)}
                              title={disabled ? `${m.label} has nothing to manage` : l.label}
                              className={`h-[36px] lg:h-7 px-2 inline-flex items-center justify-center gap-1 rounded text-[12px] font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                on ? `${l.on} shadow-[var(--shadow-card)] ring-1` : 'text-ink-secondary hover:text-ink hover:bg-white/60'
                              }`}
                            >
                              {l.icon}
                              {l.short}
                            </button>
                          )
                        })}
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="sticky bottom-0 px-4 py-3 border-t border-line bg-white/95 backdrop-blur flex flex-wrap items-center justify-between gap-2">
                <span className={`text-[12px] ${dirty ? 'font-medium text-accent-strong' : 'text-ink-muted'}`} aria-live="polite">
                  {dirty ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : `${grantedCount(saved)} of ${modules.length} modules granted`}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setChanges({})} disabled={!dirty || saving} icon={<RotateCcw className="w-3 h-3" />}>
                    Undo
                  </Button>
                  <Button size="sm" variant="primary" onClick={save} disabled={!dirty} loading={saving}>
                    Save permissions
                  </Button>
                </div>
              </div>
            </Card>

            {/* The Manager accounts these permissions apply to */}
            <Card className="overflow-hidden" aria-label="Managers">
              <CardHeader
                icon={<Users className="w-4 h-4" />}
                title="Managers"
                subtitle="Accounts these permissions apply to"
                actions={
                  <span className="h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full bg-subtle text-ink-muted ring-1 ring-inset ring-line text-[11px] font-semibold tabular-nums">
                    {managers.length}
                  </span>
                }
              />
              {managers.length === 0 ? (
                <EmptyState
                  icon={<Users className="w-5 h-5" />}
                  title="No managers yet"
                  hint="Add a manager to give them these permissions."
                  compact
                  action={
                    <Button size="sm" variant="outline" onClick={openNewManager} icon={<Plus className="w-3.5 h-3.5" />}>
                      Add Manager
                    </Button>
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table stack-sm">
                    <thead>
                      <tr>
                        <th>Manager</th>
                        <th>Status</th>
                        <th>Last sign-in</th>
                        <th className="text-right">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {managers.map((m) => {
                        const record = accountsApi.data?.find((u) => u.id === m.id)
                        return (
                          <tr key={m.id}>
                            <td>
                              <div className="flex items-center gap-2.5 min-w-0">
                                <UserAvatar name={m.name} muted={!m.isActive} />
                                <div className="min-w-0 text-left">
                                  <div className={`font-semibold truncate ${m.isActive ? 'text-ink' : 'text-ink-muted'}`}>{m.name}</div>
                                  <div className="text-[11.5px] text-ink-muted truncate">
                                    <span className="font-mono">{m.employeeId}</span>
                                    {m.designation ? ` · ${m.designation}` : ''}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                <StatusBadge status={m.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                                {record && (
                                  <Pill
                                    className={record.appAccess ? 'bg-white text-ink-secondary ring-line-strong' : 'bg-subtle text-ink-muted ring-line'}
                                    title={record.appAccess ? 'Can sign in to the mobile app' : 'Mobile app blocked'}
                                  >
                                    <Smartphone className="w-3 h-3" aria-hidden />
                                    <span className="sr-only">Mobile app: </span>
                                    {record.appAccess ? 'App' : 'No app'}
                                  </Pill>
                                )}
                              </div>
                            </td>
                            <td className="whitespace-nowrap text-ink-secondary tabular-nums">
                              {m.lastLoginAt ? formatDateTime(m.lastLoginAt) : <span className="text-ink-faint">Never</span>}
                            </td>
                            <td className="text-right whitespace-nowrap" data-label="">
                              <div className="inline-flex items-center gap-0.5">
                                <IconButton label={`Edit account of ${m.name}`} onClick={() => openEditManager(m)} disabled={!accountsApi.data}>
                                  <Pencil className="w-3.5 h-3.5" />
                                </IconButton>
                                {isSuperAdmin && (
                                  <IconButton label={`View password of ${m.name}`} onClick={() => setRevealing(m)}>
                                    <KeyRound className="w-3.5 h-3.5" />
                                  </IconButton>
                                )}
                                <IconButton
                                  label={`${m.isActive ? 'Deactivate' : 'Activate'} ${m.name}`}
                                  tone={m.isActive ? 'danger' : 'neutral'}
                                  onClick={() => setToggling(m)}
                                >
                                  <Power className={`w-3.5 h-3.5 ${m.isActive ? '' : 'text-success'}`} />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}
      </DataState>

      <Modal
        isOpen={account !== null}
        onClose={() => setAccount(null)}
        title={account?.editing === 'new' ? 'Add Manager' : 'Edit Manager'}
        subtitle="Managers sign in to this admin panel with their employee ID"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setAccount(null)} disabled={savingAccount}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="manager-form" loading={savingAccount}>
              {account?.editing === 'new' ? 'Create Manager' : 'Save Changes'}
            </Button>
          </>
        }
      >
        {account && (
          <form id="manager-form" onSubmit={saveAccount} className="space-y-3" autoComplete="off">
            <FormError message={accountError} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Employee ID" required hint="Used to sign in">
                <TextInput value={account.form.employeeId} onChange={(e) => setForm('employeeId', e.target.value)} maxLength={40} className="font-mono" autoFocus />
              </Field>
              <Field label="Full name" required>
                <TextInput value={account.form.name} onChange={(e) => setForm('name', e.target.value)} maxLength={120} />
              </Field>
              <Field label="Designation">
                <TextInput value={account.form.designation} onChange={(e) => setForm('designation', e.target.value)} placeholder="e.g. Production Manager" maxLength={100} />
              </Field>
              {(account.editing === 'new' || isSuperAdmin) && (
                <Field
                  label={account.editing === 'new' ? 'Password' : 'New password'}
                  required={account.editing === 'new'}
                  hint={account.editing === 'new' ? 'At least 6 characters' : 'Leave blank to keep the current password'}
                >
                  <TextInput type="password" value={account.form.password} onChange={(e) => setForm('password', e.target.value)} autoComplete="new-password" />
                </Field>
              )}
            </div>
            {account.editing !== 'new' && !isSuperAdmin && (
              <p className="text-[11px] text-ink-muted">Only the Super Admin can change this manager's password.</p>
            )}
            <Toggle checked={account.form.isActive} onChange={(v) => setForm('isActive', v)} label="Active" description="Deactivated managers cannot sign in" />
            <Toggle
              checked={account.form.appAccess}
              onChange={(v) => setForm('appAccess', v)}
              label="Mobile app access"
              description="Can sign in to the mobile app, with the same module access as on the web"
            />
            {account.editing === 'new' && (
              <p className="text-[11px] text-ink-muted">A new manager gets the Manager permissions shown on this page, like every other Manager.</p>
            )}
          </form>
        )}
      </Modal>

      <RevealPasswordModal user={revealing} onClose={() => setRevealing(null)} />

      <ConfirmModal
        isOpen={toggling !== null}
        title={toggling?.isActive ? 'Deactivate manager?' : 'Activate manager?'}
        message={
          toggling?.isActive
            ? `${toggling?.name} will be signed out now and cannot sign in until activated again.`
            : `${toggling?.name} can sign in again, with the same access as every Manager.`
        }
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Activate'}
        danger={toggling?.isActive}
        onConfirm={toggleActive}
        onClose={() => setToggling(null)}
      />
    </div>
  )
}
