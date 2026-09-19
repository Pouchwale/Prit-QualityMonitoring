import React, { useMemo, useState } from 'react'
import { Edit2, Info, KeyRound, Plus, Search, UserX } from 'lucide-react'
import type { Department, Machine, Role, Shift, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ROLE_LABEL, useAuth } from '../../lib/auth'
import { formatClockRange, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, MultiSelectList, Select, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { RevealPasswordModal } from './RevealPasswordModal'

type RoleTab = 'ALL' | Role

const TABS: { value: RoleTab; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'WORKER', label: 'Workers' },
  { value: 'MANAGER', label: 'Managers' },
  { value: 'ADMIN', label: 'Admins' },
  { value: 'SUPER_ADMIN', label: 'Super Admins' }
]

const ROLE_BADGE: Record<Role, string> = {
  WORKER: 'bg-subtle text-ink-secondary border-line',
  MANAGER: 'bg-due-bg text-due border-due-line',
  ADMIN: 'bg-blue-50 text-accent border-blue-200',
  SUPER_ADMIN: 'bg-ink text-white border-ink'
}

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

const RoleBadge: React.FC<{ role: Role }> = ({ role }) => (
  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-medium ${ROLE_BADGE[role]}`}>{ROLE_LABEL[role]}</span>
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

export const WorkersPage: React.FC = () => {
  const { user: me, can } = useAuth()
  const canEdit = can('workers', 'manage')
  const allowedRoles = manageableRoles(me?.role)
  const canEditUser = (u: User) => allowedRoles.includes(u.role)
  const notify = useToast()
  const usersApi = useApi<User[]>('/api/users')
  const machinesApi = useApi<Machine[]>('/api/machines')
  const departmentsApi = useApi<Department[]>('/api/departments')
  const shiftsApi = useApi<Shift[]>('/api/shifts')

  const [tab, setTab] = useState<RoleTab>('ALL')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [disabling, setDisabling] = useState<User | null>(null)
  const [revealing, setRevealing] = useState<User | null>(null)
  // Only the Super Admin can view passwords.
  const canViewPasswords = me?.role === 'SUPER_ADMIN'

  const users = useMemo(() => usersApi.data ?? [], [usersApi.data])
  const machines = machinesApi.data ?? []
  const departments = departmentsApi.data ?? []
  const shifts = shiftsApi.data ?? []

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const counts = useMemo(() => {
    const c: Record<RoleTab, number> = { ALL: users.length, WORKER: 0, MANAGER: 0, ADMIN: 0, SUPER_ADMIN: 0 }
    for (const u of users) c[u.role]++
    return c
  }, [users])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (tab !== 'ALL' && u.role !== tab) return false
      if (!q) return true
      return [u.name, u.employeeId, u.designation, u.departmentName, u.shiftName, u.phone].some((v) => v?.toLowerCase().includes(q))
    })
  }, [users, tab, search])

  const isSelf = editing !== null && editing !== 'new' && editing.id === me?.id
  // Only the Super Admin manages passwords: other users' here, their own in My Account.
  const canResetPassword = me?.role === 'SUPER_ADMIN' && !isSelf

  const openNew = () => {
    setForm({ ...emptyForm, role: tab !== 'ALL' && allowedRoles.includes(tab) ? tab : 'WORKER' })
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (u: User) => {
    setForm({
      employeeId: u.employeeId,
      name: u.name,
      role: u.role,
      designation: u.designation ?? '',
      departmentId: u.departmentId ?? '',
      shiftId: u.shiftId ?? '',
      phone: u.phone ?? '',
      password: '',
      isActive: u.isActive,
      appAccess: u.appAccess,
      machineIds: u.machineIds
    })
    setFormError(null)
    setEditing(u)
  }

  const close = () => setEditing(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const creating = editing === 'new'
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
        // Only meaningful for workers; keep the stored value for others (turning it off would sign them out).
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
      setEditing(null)
      usersApi.reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const disable = async () => {
    if (!disabling) return
    try {
      await api.del(`/api/users/${disabling.id}`)
      notify('success', 'User disabled', `${disabling.name} can no longer sign in. Their check history is kept.`)
      usersApi.reload()
    } catch (err) {
      notify('error', 'Could not disable user', errorText(err))
    }
  }

  const departmentOptions = departments.filter((d) => d.isActive || d.id === form.departmentId)
  const shiftOptions = shifts.filter((s) => s.isActive || s.id === form.shiftId)
  const machineItems = machines
    .filter((m) => m.isActive || form.machineIds.includes(m.id))
    .map((m) => ({
      id: m.id,
      label: m.isActive ? m.name : `${m.name} (disabled)`,
      detail: [m.departmentName, m.code].filter(Boolean).join(' · ')
    }))
  const pickerError = machinesApi.error || departmentsApi.error || shiftsApi.error

  return (
    <div className="space-y-4">
      <PageHeader
        title="Workers & Users"
        description="Accounts for shop-floor workers, managers and administrators, and which machines each worker can check"
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add User
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="inline-flex rounded border border-line-strong overflow-hidden">
          {TABS.filter((t) => t.value === 'ALL' || counts[t.value] > 0 || allowedRoles.includes(t.value as Role)).map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`h-[40px] lg:h-8 px-3 text-xs font-medium whitespace-nowrap border-r border-line-strong last:border-r-0 transition-colors ${
                tab === t.value ? 'bg-accent text-white' : 'bg-white text-ink-secondary hover:bg-slate-50'
              }`}
            >
              {t.label}
              <span className={`ml-1.5 text-[11px] lg:text-[10px] ${tab === t.value ? 'text-white/80' : 'text-ink-faint'}`}>{counts[t.value]}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search name, employee ID, department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-[40px] lg:h-8 pl-8 pr-3 border border-line-strong rounded text-[16px] lg:text-xs bg-white placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <DataState
        loading={usersApi.loading}
        error={usersApi.error}
        onRetry={usersApi.reload}
        empty={!usersApi.loading && filtered.length === 0}
        emptyText={users.length === 0 ? 'No users yet' : 'No users match the filters'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Name</th>
                <th className="py-2.5 px-3.5">Employee ID</th>
                <th className="py-2.5 px-3.5">Role</th>
                <th className="py-2.5 px-3.5">Department</th>
                <th className="py-2.5 px-3.5">Shift</th>
                <th className="py-2.5 px-3.5">Machines</th>
                <th className="py-2.5 px-3.5">Mobile app</th>
                <th className="py-2.5 px-3.5">Status</th>
                <th className="py-2.5 px-3.5">Last login</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((u) => {
                const worker = u.role === 'WORKER'
                const self = u.id === me?.id
                return (
                  <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <span className={`font-semibold ${u.isActive ? 'text-ink' : 'text-ink-muted'}`}>{u.name}</span>
                      {self && <span className="ml-1.5 text-[11px] lg:text-[10px] text-ink-muted">(you)</span>}
                      {u.designation && <span className="block text-[11px] text-ink-muted">{u.designation}</span>}
                    </td>
                    <td className="py-2.5 px-3.5 font-mono text-ink-secondary whitespace-nowrap">{u.employeeId}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">{u.departmentName ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">{u.shiftName ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      {worker ? (
                        u.machineIds.length ? (
                          <span className="text-ink">{u.machineIds.length}</span>
                        ) : (
                          <span className="text-exception" title="This worker cannot see any checks">
                            None
                          </span>
                        )
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      {u.appAccess ? (
                        <span className="text-success font-medium">Allowed</span>
                      ) : (
                        <span className="text-ink-muted">Blocked</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <StatusBadge status={u.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-ink-secondary">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="text-ink-faint">Never</span>}
                    </td>
                    {canEdit && (
                      <td className="py-2 px-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex gap-1.5">
                          {canEditUser(u) && (
                            <Button size="sm" variant="outline" onClick={() => openEdit(u)} icon={<Edit2 className="w-3 h-3 text-ink-muted" />}>
                              Edit
                            </Button>
                          )}
                          {canViewPasswords && (
                            <Button size="sm" variant="ghost" onClick={() => setRevealing(u)} title="View password" aria-label={`View password of ${u.name}`} icon={<KeyRound className="w-3.5 h-3.5 text-ink-muted" />} />
                          )}
                          {u.isActive && !self && canEditUser(u) && (
                            <Button size="sm" variant="ghost" onClick={() => setDisabling(u)} title="Disable" aria-label={`Disable ${u.name}`} icon={<UserX className="w-3.5 h-3.5 text-failed" />} />
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add User' : 'Edit User'}
        subtitle="Workers sign in to the mobile app with their employee ID; managers and admins use this web console"
        maxWidth="xl"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="user-form" loading={saving}>
              {editing === 'new' ? 'Create User' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="user-form" onSubmit={submit} className="space-y-3" autoComplete="off">
          <FormError message={formError} />
          {pickerError && <FormError message={`Could not load lists: ${pickerError}`} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Employee ID" required hint="Used to sign in">
              <TextInput value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} placeholder="e.g. EMP-104" maxLength={40} className="font-mono" autoFocus />
            </Field>
            <Field label="Full name" required>
              <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ravi Patel" maxLength={120} />
            </Field>
            <Field label="Role" required hint={isSelf ? 'You cannot change your own role' : ROLE_HINT[form.role]}>
              <Select value={form.role} onChange={(e) => set('role', e.target.value as Role)} disabled={isSelf || allowedRoles.length === 1}>
                {(isSelf ? [form.role] : allowedRoles).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Designation" hint="Shown as “Role” on the worker's mobile profile">
              <TextInput value={form.designation} onChange={(e) => set('designation', e.target.value)} placeholder="e.g. Quality Inspector" maxLength={100} />
            </Field>
            <Field label="Department">
              <Select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">No department</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.isActive ? d.name : `${d.name} (inactive)`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Shift">
              <Select value={form.shiftId} onChange={(e) => set('shiftId', e.target.value)}>
                <option value="">No shift</option>
                {shiftOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.name} (${formatClockRange(s.startTime, s.endTime)})${s.isActive ? '' : ' (inactive)'}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Phone">
              <TextInput type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="Optional" maxLength={30} />
            </Field>
            {(editing === 'new' || canResetPassword) && (
              <Field
                label={editing === 'new' ? 'Password' : 'New password'}
                required={editing === 'new'}
                hint={editing === 'new' ? 'At least 6 characters' : 'Leave blank to keep the current password'}
              >
                <TextInput type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" minLength={editing === 'new' ? 6 : undefined} />
              </Field>
            )}
          </div>

          {editing !== 'new' && !canResetPassword && (
            <p className="text-[11px] text-ink-muted">
              {isSelf && me?.role === 'SUPER_ADMIN' ? 'To change your own password, use My Account.' : 'Only the Super Admin can change passwords.'}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <Toggle
              checked={form.isActive}
              onChange={(v) => set('isActive', v)}
              disabled={isSelf}
              label="Active"
              description={isSelf ? 'You cannot disable your own account' : 'Disabled users cannot sign in'}
            />
            <Toggle
              checked={form.appAccess}
              onChange={(v) => set('appAccess', v)}
              label="Mobile app access"
              description={form.role === 'WORKER' ? 'Can sign in to the mobile app to do quality checks' : 'Can sign in to the mobile app, with the same access as on the web'}
            />
          </div>

          {form.role === 'WORKER' && (
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-semibold text-slate-700">Machines this worker can check</span>
                <span className="text-[11px] text-ink-muted">{form.machineIds.length} selected</span>
              </div>
              <MultiSelectList
                items={machineItems}
                selected={form.machineIds}
                onChange={(ids) => set('machineIds', ids)}
                emptyText={machinesApi.loading ? 'Loading machines…' : 'No machines configured yet'}
              />
              <div className="flex items-start gap-1.5 mt-1.5 text-[11px] text-ink-muted">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  Schedules without an assigned worker show to every worker on the same shift who has access to that machine. Schedules assigned to
                  a specific worker show only to that worker.
                </span>
              </div>
            </div>
          )}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={disabling !== null}
        title="Disable user"
        danger
        confirmLabel="Disable"
        message={
          <>
            Disable <span className="font-semibold text-ink">{disabling?.name}</span> ({disabling?.employeeId})? They are signed out and can no
            longer sign in. Users are never deleted, so their check history is kept; you can re-enable them later from Edit.
          </>
        }
        onConfirm={disable}
        onClose={() => setDisabling(null)}
      />
      <RevealPasswordModal user={revealing} onClose={() => setRevealing(null)} />
    </div>
  )
}
