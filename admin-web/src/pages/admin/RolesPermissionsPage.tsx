import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertOctagon,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarOff,
  ClipboardCheck,
  Clock3,
  Cpu,
  Lock,
  FileSpreadsheet,
  Gauge,
  History,
  LayoutDashboard,
  LayoutGrid,
  LogIn,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
  Wifi,
  Workflow
} from 'lucide-react'
import type { Action, ActionMatrix, ActionSet, AuditLog, ModuleInfo, ModuleKey, PermissionMatrixData, UserPermissionData } from '../../types'
import { formatDateTime } from '../../lib/format'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { Segmented } from '../../components/ui/Toolbar'
import { Pill, RoleBadge, UserAvatar } from '../../components/ui/Chips'

const ACTIONS: Action[] = ['view', 'create', 'edit', 'delete', 'approve', 'export']
const ACTION_LABEL: Record<Action, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export' }

/** The same icons as the sidebar, so a module is easy to find. */
const MODULE_ICON: Partial<Record<ModuleKey, React.ReactNode>> = {
  dashboard: <LayoutDashboard className="w-4 h-4" />,
  checks: <ClipboardCheck className="w-4 h-4" />,
  jobs: <Briefcase className="w-4 h-4" />,
  exceptions: <AlertOctagon className="w-4 h-4" />,
  reports: <FileSpreadsheet className="w-4 h-4" />,
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
  settings: <Settings className="w-4 h-4" />,
  shift_signin: <LogIn className="w-4 h-4" />,
  wifi_rule: <Wifi className="w-4 h-4" />,
  app_jobs: <Briefcase className="w-4 h-4" />,
  app_performance: <Gauge className="w-4 h-4" />,
  app_history: <History className="w-4 h-4" />
}

const none = (): ActionSet => ({ view: false, create: false, edit: false, delete: false, approve: false, export: false })
/** Whether any action is allowed (an app feature such as Jobs has no View). */
const anyOf = (s: ActionSet | undefined) => ACTIONS.some((a) => !!s?.[a])
const same = (a: ActionSet | undefined, b: ActionSet | undefined) => ACTIONS.every((x) => !!a?.[x] === !!b?.[x])
const describe = (s: ActionSet | undefined) => {
  const on = ACTIONS.filter((a) => s?.[a]).map((a) => ACTION_LABEL[a])
  return on.length ? on.join(', ') : 'No access'
}

/** Turns one action on or off, keeping the rules the server keeps: a write needs view, no view means nothing. */
function toggle(module: ModuleInfo, set: ActionSet, action: Action): ActionSet {
  const next = { ...set, [action]: !set[action] }
  if (action === 'view' && !next.view) return none()
  if (action !== 'view' && next[action] && module.actions.includes('view')) next.view = true
  for (const a of ACTIONS) if (!module.actions.includes(a)) next[a] = false
  return next
}
const preset = (module: ModuleInfo, level: 'none' | 'view' | 'all'): ActionSet => {
  const s = none()
  if (level === 'none') return s
  for (const a of module.actions) s[a] = level === 'all' || a === 'view'
  return s
}

type Tab = 'ADMIN' | 'MANAGER' | 'WORKER' | 'USER' | 'HISTORY'
const ROLE_TABS: { value: Tab; label: string }[] = [
  { value: 'ADMIN', label: 'Admin role' },
  { value: 'MANAGER', label: 'Manager role' },
  { value: 'WORKER', label: 'Worker role' },
  { value: 'USER', label: 'One user' },
  { value: 'HISTORY', label: 'History' }
]
type RoleKey = 'ADMIN' | 'MANAGER' | 'WORKER'
const ROLE_NAME: Record<RoleKey, string> = { ADMIN: 'Admin', MANAGER: 'Manager', WORKER: 'Worker' }

/**
 * Super Admin only: what each role may do in each module (view, create, edit, delete), and where
 * needed what one Admin or Manager may do instead of their role. The server enforces the same
 * permissions on every request and denies anything not granted; every change is confirmed, saved in
 * one transaction and written to the audit log. Roles themselves are changed on Workers & Users.
 */
export const RolesPermissionsPage: React.FC = () => {
  const modulesApi = useApi<ModuleInfo[]>('/api/access/modules')
  const matrixApi = useApi<PermissionMatrixData>('/api/access/matrix')
  const [tab, setTab] = useState<Tab>('MANAGER')
  const [userId, setUserId] = useState<string | null>(null)

  const allModules = useMemo(() => modulesApi.data ?? [], [modulesApi.data])
  // Admin-panel modules for Admin and Manager; the worker app's features for Worker.
  const modules = useMemo(() => allModules.filter((m) => (m.audience ?? 'panel') === 'panel'), [allModules])
  const workerModules = useMemo(() => allModules.filter((m) => m.audience === 'worker'), [allModules])
  const accounts = useMemo(() => matrixApi.data?.users ?? [], [matrixApi.data])
  const counts = useMemo(() => {
    const c = { ADMIN: 0, MANAGER: 0 }
    for (const u of accounts) if (u.isActive) c[u.role]++
    return c
  }, [accounts])

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldCheck className="w-4.5 h-4.5" />}
        title="Roles & Permissions"
        description="What each role can view, create, edit, delete, approve and export"
        info="Only the Super Admin sees this page. Each role has one set of permissions; one Admin or Manager can be given their own for some modules, replacing their role's. Anything not ticked is denied. Activating and deactivating records is always the Super Admin's alone and cannot be granted. The server checks the same permissions on every request, and changes apply on the user's next click. Promote or demote accounts on Workers & Users."
      />

      <DataState
        loading={matrixApi.loading || modulesApi.loading}
        error={matrixApi.error || modulesApi.error}
        onRetry={() => {
          matrixApi.reload()
          modulesApi.reload()
        }}
        empty={matrixApi.data && modulesApi.data ? false : undefined}
      >
        {matrixApi.data && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Tab>
                label="Whose permissions"
                value={tab}
                onChange={setTab}
                options={ROLE_TABS.map((t) => ({
                  ...t,
                  count: t.value === 'USER' ? accounts.filter((a) => a.overrides > 0).length : t.value === 'ADMIN' || t.value === 'MANAGER' ? counts[t.value] : undefined
                }))}
              />
              <p className="text-[12px] text-ink-muted">Super Admin: always every permission, and the only one who activates or deactivates records</p>
            </div>

            {tab === 'HISTORY' ? (
              <PermissionHistory />
            ) : tab === 'USER' ? (
              <UserPermissions
                modules={modules}
                accounts={accounts}
                userId={userId}
                onPick={setUserId}
                onSaved={matrixApi.reload}
              />
            ) : (
              <RoleMatrix
                key={tab}
                role={tab}
                modules={tab === 'WORKER' ? workerModules : modules}
                saved={matrixApi.data.roles[tab]}
                accountCount={tab === 'WORKER' ? null : counts[tab]}
                onSaved={(m) => matrixApi.setData((d) => (d ? { ...d, roles: { ...d.roles, [tab]: m } } : d))}
              />
            )}
          </div>
        )}
      </DataState>
    </div>
  )
}

// ---------------------------------------------------------------------------- The matrix

interface MatrixProps {
  modules: ModuleInfo[]
  /** What is shown ticked. */
  value: ActionMatrix
  /** What is saved, to mark changed rows. */
  saved: ActionMatrix
  onChange: (module: ModuleInfo, set: ActionSet) => void
  disabled?: boolean
  /** Per module: a note after the name (e.g. "Own permissions") and an extra control at the row's end. */
  rowNote?: (m: ModuleInfo) => React.ReactNode
  rowEnd?: (m: ModuleInfo) => React.ReactNode
}

const PermissionMatrix: React.FC<MatrixProps> = (props) => (
  <>
    <div className="hidden md:block">
      <MatrixTable {...props} />
    </div>
    <div className="md:hidden">
      <MatrixCards {...props} />
    </div>
  </>
)

/** Phones: one card per module, its actions as tick boxes (actions that do not apply are left out). */
const MatrixCards: React.FC<MatrixProps> = ({ modules, value, saved, onChange, disabled, rowNote, rowEnd }) => (
  <ul className="divide-y divide-line">
    {modules.map((m) => {
      const set = value[m.key] ?? none()
      const changed = !same(set, saved[m.key])
      return (
        <li key={m.key} className={`px-3 py-3 space-y-2 ${changed ? 'bg-accent-soft/40' : ''}`}>
          <div className="flex items-start gap-2.5">
            <span className="w-7 h-7 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
              {MODULE_ICON[m.key] ?? <LayoutGrid className="w-4 h-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[13px] font-semibold text-ink">{m.label}</span>
                {changed && <Pill className="bg-accent-soft text-accent-strong ring-accent-line">Changed</Pill>}
                {rowNote?.(m)}
              </div>
              <p className="text-[11.5px] text-ink-muted leading-snug">{m.description}</p>
            </div>
            {rowEnd?.(m)}
          </div>
          <div className="flex flex-wrap gap-1.5 pl-[38px]">
            {m.actions.map((a) => (
              <label
                key={a}
                className={`h-9 px-2.5 inline-flex items-center gap-1.5 rounded-md border text-[12.5px] cursor-pointer ${set[a] ? 'border-accent-line bg-accent-soft text-accent-strong' : 'border-line bg-white text-ink-secondary'}`}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[var(--color-accent)]"
                  checked={!!set[a]}
                  disabled={disabled}
                  onChange={() => onChange(m, toggle(m, set, a))}
                  aria-label={`${m.label}: ${ACTION_LABEL[a]}`}
                />
                {ACTION_LABEL[a]}
              </label>
            ))}
            {m.activation && (
              <span className="h-9 inline-flex items-center">
                <ActivationLock />
              </span>
            )}
          </div>
        </li>
      )
    })}
  </ul>
)

/** The action columns the shown modules use. */
const columnsFor = (modules: ModuleInfo[]) => ACTIONS.filter((a) => modules.some((m) => m.actions.includes(a)))

/** Activating / deactivating: shown, never a tick box (the Super Admin's alone, lib/activation.ts on the server). */
const ActivationLock: React.FC = () => (
  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted whitespace-nowrap" title="Only the Super Admin can activate or deactivate these records. This cannot be granted.">
    <Lock className="w-3 h-3" aria-hidden />
    Super Admin only
  </span>
)

const MatrixTable: React.FC<MatrixProps> = ({ modules, value, saved, onChange, disabled, rowNote, rowEnd }) => {
  const columns = columnsFor(modules)
  const activation = modules.some((m) => m.activation)
  return (
  <div className="overflow-x-auto">
    <table className="data-table min-w-[640px]">
      <thead>
        <tr>
          <th>Module</th>
          {columns.map((a) => (
            <th key={a} className="text-center w-[80px]">
              {ACTION_LABEL[a]}
            </th>
          ))}
          {activation && <th className="text-center w-[120px]">Activate / Deactivate</th>}
          {rowEnd && <th className="text-right w-[120px]"><span className="sr-only">Options</span></th>}
        </tr>
      </thead>
      <tbody>
        {modules.map((m) => {
          const set = value[m.key] ?? none()
          const changed = !same(set, saved[m.key])
          return (
            <tr key={m.key} className={changed ? 'bg-accent-soft/40' : undefined}>
              <td>
                <div className="flex items-start gap-2.5 min-w-0">
                  <span className="w-7 h-7 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
                    {MODULE_ICON[m.key] ?? <LayoutGrid className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-semibold text-ink">{m.label}</span>
                      {changed && <Pill className="bg-accent-soft text-accent-strong ring-accent-line">Changed</Pill>}
                      {rowNote?.(m)}
                    </div>
                    <p className="text-[11.5px] text-ink-muted leading-snug max-w-[420px]">{m.description}</p>
                  </div>
                </div>
              </td>
              {columns.map((a) => {
                const applies = m.actions.includes(a)
                if (!applies) {
                  return (
                    <td key={a} className="text-center text-ink-faint" title={`${m.label} has no ${ACTION_LABEL[a].toLowerCase()} action`}>
                      <span aria-label="Not applicable">—</span>
                    </td>
                  )
                }
                const note = m.notes?.[a]
                return (
                  <td key={a} className="text-center">
                    <label className="inline-flex items-center justify-center w-9 h-9 lg:w-7 lg:h-7 rounded cursor-pointer hover:bg-subtle" title={note ?? `${ACTION_LABEL[a]} ${m.label}`}>
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer disabled:cursor-not-allowed"
                        checked={!!set[a]}
                        disabled={disabled}
                        onChange={() => onChange(m, toggle(m, set, a))}
                        aria-label={`${m.label}: ${ACTION_LABEL[a]}${note ? ` (${note})` : ''}`}
                      />
                    </label>
                  </td>
                )
              })}
              {activation && <td className="text-center">{m.activation ? <ActivationLock /> : <span className="text-ink-faint" aria-label="Not applicable">—</span>}</td>}
              {rowEnd && <td className="text-right whitespace-nowrap">{rowEnd(m)}</td>}
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
  )
}

/** The changes about to be saved, for the confirmation. */
const ChangeList: React.FC<{ items: { label: string; from: string; to: string }[] }> = ({ items }) => (
  <ul className="mt-2 max-h-[260px] overflow-y-auto space-y-1 text-[12.5px]">
    {items.map((c) => (
      <li key={c.label} className="rounded-md bg-subtle px-2.5 py-1.5">
        <span className="font-semibold text-ink">{c.label}</span>
        <span className="text-ink-muted">: {c.from} → </span>
        <span className="text-ink">{c.to}</span>
      </li>
    ))}
  </ul>
)

/** Unsaved changes ask before the browser tab closes. */
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = true
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

const SaveBar: React.FC<{ dirty: number; summary: string; saving: boolean; onUndo: () => void; onSave: () => void }> = ({ dirty, summary, saving, onUndo, onSave }) => (
  <div className="sticky bottom-0 px-4 py-3 border-t border-line bg-white/95 backdrop-blur flex flex-wrap items-center justify-between gap-2">
    <span className={`text-[12px] ${dirty ? 'font-medium text-accent-strong' : 'text-ink-muted'}`} aria-live="polite">
      {dirty ? `${dirty} unsaved ${dirty === 1 ? 'change' : 'changes'}` : summary}
    </span>
    <div className="flex gap-2">
      <Button size="sm" variant="ghost" onClick={onUndo} disabled={!dirty || saving} icon={<RotateCcw className="w-3 h-3" />}>
        Undo
      </Button>
      <Button size="sm" variant="primary" onClick={onSave} disabled={!dirty} loading={saving}>
        Save permissions
      </Button>
    </div>
  </div>
)

// ---------------------------------------------------------------------------- A role

const SetAll: React.FC<{ className: string; onSet: (level: 'none' | 'view' | 'all') => void; disabled: boolean }> = ({ className, onSet, disabled }) => (
  <div role="group" aria-label="Set every module" className={`${className} flex-wrap items-center gap-1`}>
    <span className="text-[11.5px] text-ink-muted mr-1">Set all</span>
    <Button size="sm" variant="ghost" onClick={() => onSet('none')} disabled={disabled}>
      No access
    </Button>
    <Button size="sm" variant="ghost" onClick={() => onSet('view')} disabled={disabled}>
      View only
    </Button>
    <Button size="sm" variant="ghost" onClick={() => onSet('all')} disabled={disabled}>
      Everything
    </Button>
  </div>
)

const RoleMatrix: React.FC<{
  role: RoleKey
  modules: ModuleInfo[]
  saved: ActionMatrix
  /** Active accounts of the role (null: not counted here). */
  accountCount: number | null
  onSaved: (m: ActionMatrix) => void
}> = ({ role, modules, saved, accountCount, onSaved }) => {
  const notify = useToast()
  const [changes, setChanges] = useState<Partial<ActionMatrix>>({})
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const draft = useMemo(() => ({ ...saved, ...changes }) as ActionMatrix, [saved, changes])
  const changed = modules.filter((m) => !same(draft[m.key], saved[m.key]))
  useLeaveWarning(changed.length > 0)
  const name = ROLE_NAME[role]
  const granted = modules.filter((m) => anyOf(saved[m.key])).length

  const setAll = (level: 'none' | 'view' | 'all') => setChanges(Object.fromEntries(modules.map((m) => [m.key, preset(m, level)])))

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.put<{ permissions: ActionMatrix }>(`/api/access/roles/${role}`, {
        modules: Object.fromEntries(changed.map((m) => [m.key, draft[m.key]]))
      })
      onSaved(result.permissions)
      setChanges({})
      notify('success', `${name} permissions saved`, `Every ${name} gets them on their next click. The change is in the audit log.`)
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="overflow-clip" aria-label={`${name} permissions`}>
      <CardHeader
        icon={<ShieldCheck className="w-4 h-4" />}
        title={`${name} role`}
        subtitle={
          accountCount === null
            ? 'Applies to every worker in the worker app. Doing checks and reporting exceptions are always allowed.'
            : `Applies to ${accountCount} active ${name.toLowerCase()}${accountCount === 1 ? '' : 's'}, except modules set for one user`
        }
        actions={<SetAll className="hidden sm:flex" onSet={setAll} disabled={saving} />}
      />
      {/* Phones: the Set all buttons get their own row. */}
      <SetAll className="sm:hidden flex px-3 py-2 border-b border-line" onSet={setAll} disabled={saving} />
      <PermissionMatrix
        modules={modules}
        value={draft}
        saved={saved}
        disabled={saving}
        onChange={(m, set) => setChanges((c) => ({ ...c, [m.key]: set }))}
      />
      <SaveBar
        dirty={changed.length}
        summary={`${granted} of ${modules.length} modules allowed`}
        saving={saving}
        onUndo={() => setChanges({})}
        onSave={() => setConfirming(true)}
      />
      <ConfirmModal
        isOpen={confirming}
        title={`Change the ${name} role's permissions?`}
        confirmLabel="Save permissions"
        message={
          <div>
            <p>
              {accountCount === null
                ? 'These changes apply to every worker on their next action in the app.'
                : `These changes apply to every ${name} (${accountCount} active) on their next click, except modules set for one user.`}
            </p>
            <ChangeList items={changed.map((m) => ({ label: m.label, from: describe(saved[m.key]), to: describe(draft[m.key]) }))} />
          </div>
        }
        onConfirm={save}
        onClose={() => setConfirming(false)}
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------- One user

const UserPermissions: React.FC<{
  modules: ModuleInfo[]
  accounts: PermissionMatrixData['users']
  userId: string | null
  onPick: (id: string | null) => void
  onSaved: () => void
}> = ({ modules, accounts, userId, onPick, onSaved }) => {
  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState icon={<UserCog className="w-5 h-5" />} title="No Admins or Managers yet" hint="Promote an account on Workers & Users first." />
      </Card>
    )
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-4 items-start">
      <Card className="overflow-hidden" aria-label="Admins and Managers">
        <CardHeader icon={<Users className="w-4 h-4" />} title="Admins and Managers" subtitle="Choose whose permissions to set" />
        <ul className="divide-y divide-line max-h-[560px] overflow-y-auto">
          {accounts.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => onPick(u.id)}
                aria-pressed={u.id === userId}
                className={`w-full text-left flex items-center gap-2.5 px-3 py-2.5 transition-colors ${u.id === userId ? 'bg-accent-soft/60' : 'hover:bg-subtle'}`}
              >
                <UserAvatar name={u.name} muted={!u.isActive} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] font-semibold truncate ${u.isActive ? 'text-ink' : 'text-ink-muted'}`}>{u.name}</span>
                  <span className="block text-[11.5px] text-ink-muted truncate">
                    <span className="font-mono">{u.employeeId}</span>
                    {u.overrides > 0 ? ` · ${u.overrides} own` : ' · role permissions'}
                    {!u.isActive ? ' · disabled' : ''}
                  </span>
                </span>
                <RoleBadge role={u.role} />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {userId ? (
        <UserMatrix key={userId} userId={userId} modules={modules} onSaved={onSaved} />
      ) : (
        <Card>
          <EmptyState icon={<UserCog className="w-5 h-5" />} title="Choose an Admin or Manager" hint="Their role's permissions are shown, and you can set different ones for some modules." />
        </Card>
      )}
    </div>
  )
}

const UserMatrix: React.FC<{ userId: string; modules: ModuleInfo[]; onSaved: () => void }> = ({ userId, modules, onSaved }) => {
  const notify = useToast()
  const dataApi = useApi<UserPermissionData>(`/api/access/users/${userId}`)
  /** Per module: an action set (their own), null (back to the role's), or left out (unchanged). */
  const [changes, setChanges] = useState<Partial<Record<ModuleKey, ActionSet | null>>>({})
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const data = dataApi.data

  const ownAfter = (k: ModuleKey) => (k in changes ? changes[k] ?? null : data?.overrides[k] ?? null)
  const shown = useMemo(() => {
    if (!data) return null
    return Object.fromEntries(modules.map((m) => [m.key, ownAfter(m.key) ?? data.role[m.key] ?? none()])) as ActionMatrix
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, changes, modules])
  const changed = data
    ? modules.filter((m) => {
        if (!(m.key in changes)) return false
        const was = data.overrides[m.key] ?? null
        const next = changes[m.key] ?? null
        return next === null ? was !== null : was === null || !same(was, next)
      })
    : []
  useLeaveWarning(changed.length > 0)

  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/api/access/users/${userId}`, { modules: Object.fromEntries(changed.map((m) => [m.key, changes[m.key] ?? null])) })
      setChanges({})
      await dataApi.reload()
      onSaved()
      notify('success', 'Permissions saved', `${data?.user.name} gets them on their next click. The change is in the audit log.`)
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const label = (k: ModuleKey, own: ActionSet | null) => (own ? describe(own) : `Role (${describe(data?.role[k])})`)

  return (
    <DataState loading={dataApi.loading} error={dataApi.error} onRetry={dataApi.reload} empty={data ? false : undefined}>
      {data && shown && (
        <Card className="overflow-clip" aria-label={`${data.user.name}'s permissions`}>
          <CardHeader
            icon={<UserCog className="w-4 h-4" />}
            title={data.user.name}
            subtitle={`${data.user.employeeId} · ${data.user.role === 'ADMIN' ? 'Admin' : 'Manager'} role. A ticked change here applies to this user only.`}
            actions={<RoleBadge role={data.user.role} />}
          />
          <PermissionMatrix
            modules={modules}
            value={shown}
            saved={Object.fromEntries(modules.map((m) => [m.key, data.overrides[m.key] ?? data.role[m.key] ?? none()])) as ActionMatrix}
            disabled={saving}
            onChange={(m, set) => setChanges((c) => ({ ...c, [m.key]: set }))}
            rowNote={(m) =>
              ownAfter(m.key) ? (
                <Pill className="bg-due-bg text-due ring-due-line">Own permissions</Pill>
              ) : (
                <span className="text-[11px] text-ink-muted">· from role</span>
              )
            }
            rowEnd={(m) =>
              ownAfter(m.key) ? (
                <Button size="sm" variant="ghost" onClick={() => setChanges((c) => ({ ...c, [m.key]: null }))} disabled={saving} title="Use the role's permissions for this module">
                  Use role
                </Button>
              ) : null
            }
          />
          <SaveBar
            dirty={changed.length}
            summary={`${modules.filter((m) => data.overrides[m.key]).length} of ${modules.length} modules set for this user alone`}
            saving={saving}
            onUndo={() => setChanges({})}
            onSave={() => setConfirming(true)}
          />
          <ConfirmModal
            isOpen={confirming}
            title={`Change ${data.user.name}'s permissions?`}
            confirmLabel="Save permissions"
            message={
              <div>
                <p>These apply to {data.user.name} only, on their next click. Modules set back to “Role” follow the role again.</p>
                <ChangeList
                  items={changed.map((m) => ({ label: m.label, from: label(m.key, data.overrides[m.key] ?? null), to: label(m.key, changes[m.key] ?? null) }))}
                />
              </div>
            }
            onConfirm={save}
            onClose={() => setConfirming(false)}
          />
        </Card>
      )}
    </DataState>
  )
}

// ---------------------------------------------------------------------------- History

const HISTORY_LABEL: Record<string, string> = {
  UPDATE_ROLE_PERMISSIONS: 'Role permissions changed',
  UPDATE_USER_PERMISSIONS: 'User permissions changed',
  CHANGE_ROLE: 'Role changed',
  GRANT_DELETE_PERMISSION: 'Delete permission granted',
  REVOKE_DELETE_PERMISSION: 'Delete permission revoked',
  PERMISSION_CHANGE_DENIED: 'Refused: permission change',
  ROLE_CHANGE_DENIED: 'Refused: role change',
  ACTIVATION_DENIED: 'Refused: activate / deactivate'
}

/** The change in words: the list the server recorded, or the role change, or what was refused. */
function historyDetail(entry: AuditLog): string[] {
  const after = (entry.newValue ?? {}) as Record<string, unknown>
  const before = (entry.oldValue ?? {}) as Record<string, unknown>
  if (Array.isArray(after.changed)) return after.changed.map(String)
  if (entry.action === 'CHANGE_ROLE') return [String(after.change ?? `${before.role ?? '?'} → ${after.role ?? '?'}`)]
  if (entry.action.endsWith('_DENIED')) {
    const what = [after.requestedRole ? `requested role ${after.requestedRole}` : null, after.method && after.path ? `${after.method} ${after.path}` : null, after.reason ? String(after.reason) : null]
    return [what.filter(Boolean).join(' · ') || 'Refused']
  }
  if ('granted' in after) return [`${after.label ?? after.permission}: ${before.granted ? 'on' : 'off'} → ${after.granted ? 'on' : 'off'}`]
  return []
}

/** Super Admin only: every role and permission change, and every refused attempt, newest first. */
const PermissionHistory: React.FC = () => {
  const historyApi = useApi<AuditLog[]>('/api/access/history')
  const rows = historyApi.data ?? []
  return (
    <Card className="overflow-hidden" aria-label="Permission history">
      <CardHeader
        icon={<History className="w-4 h-4" />}
        title="Permission history"
        subtitle="Who changed which role or permission, from what to what, and refused attempts"
        info="Only the Super Admin sees these entries; they are left out of the Audit Logs page for everyone else."
      />
      <DataState loading={historyApi.loading} error={historyApi.error} onRetry={historyApi.reload} empty={!historyApi.loading && rows.length === 0}>
        <div className="overflow-x-auto">
          <table className="data-table stack-sm">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const after = (r.newValue ?? {}) as Record<string, unknown>
                const target = String(after.user ?? after.admin ?? after.role ?? r.entityId ?? '')
                const refused = r.action.endsWith('_DENIED')
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap tabular-nums">{formatDateTime(r.createdAt)}</td>
                    <td className="whitespace-nowrap">{r.userName ?? '—'}</td>
                    <td>
                      <span className={refused ? 'text-missed font-medium' : 'text-ink font-medium'}>{HISTORY_LABEL[r.action] ?? r.action}</span>
                      {target && <div className="text-[11.5px] text-ink-muted">{target}</div>}
                    </td>
                    <td className="text-[12px] text-ink-secondary">
                      {historyDetail(r).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>
    </Card>
  )
}
