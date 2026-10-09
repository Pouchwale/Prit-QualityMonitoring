import React, { useCallback, useMemo, useState } from 'react'
import { Clock3, HardHat, Info, KeyRound, Pencil, Plus, ShieldCheck, Smartphone, Trash2, UserCheck, Users, UserX } from 'lucide-react'
import type { Department, Role, Shift, User, WorkerQualityRole } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ROLE_LABEL, useAuth } from '../../lib/auth'
import { formatClockRange, formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, Select, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { RevealPasswordModal } from './RevealPasswordModal'
import { DeleteRecordsModal } from '../../components/common/DeleteRecordsModal'
import { BulkDeleteBar, RowCheckbox, useSelection } from '../../components/common/BulkSelection'
import { useDeletePermissions } from '../../lib/deletePermissions'
import { AdminDeletePermissions } from './AdminDeletePermissions'
import { Pill, RoleBadge, UserAvatar } from '../../components/ui/Chips'
import { Card, EmptyState } from '../../components/ui/Card'
import { StatCard } from '../../components/ui/StatCard'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { ShiftSignInStatusCard } from './ShiftSignIn'

type RoleTab = 'ALL' | Role

const TABS: { value: RoleTab; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'WORKER', label: 'Workers' },
  { value: 'MANAGER', label: 'Managers' },
  { value: 'ADMIN', label: 'Admins' },
  { value: 'SUPER_ADMIN', label: 'Super Admins' }
]

const QUALITY_ROLE_LABEL: Record<WorkerQualityRole, string> = {
  IPQC: 'IPQC',
  QC: 'QC',
  BOTH: 'IPQC + QC'
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
  MANAGER: 'Sees every department, with only the modules the Super Admin allows for Managers',
  ADMIN: 'Full access, manages Manager and Worker accounts',
  SUPER_ADMIN: 'Full access, including Admin accounts and Manager permissions'
}

/** IPQC / QC / both: a neutral outline chip, the text carries the meaning. */
const QualityRoleBadge: React.FC<{ role: WorkerQualityRole }> = ({ role }) => (
  <Pill className="bg-white text-ink ring-line-strong font-semibold tracking-wide" title="Quality role">
    {QUALITY_ROLE_LABEL[role]}
  </Pill>
)

/** Mobile app sign-in: allowed or blocked, with an icon so it does not rely on colour. */
const AppAccessBadge: React.FC<{ allowed: boolean }> = ({ allowed }) => (
  <Pill className={allowed ? 'bg-white text-ink-secondary ring-line-strong' : 'bg-subtle text-ink-muted ring-line'} title={allowed ? 'Can sign in to the mobile app' : 'Mobile app blocked'}>
    <Smartphone className="w-3 h-3" aria-hidden />
    <span className="sr-only">Mobile app: </span>
    {allowed ? 'App' : 'No app'}
  </Pill>
)

interface FormState {
  employeeId: string
  name: string
  role: Role
  workerQualityRole: WorkerQualityRole
  designation: string
  departmentId: string
  shiftId: string
  phone: string
  password: string
  isActive: boolean
  appAccess: boolean
}

const emptyForm: FormState = {
  employeeId: '',
  name: '',
  role: 'WORKER',
  workerQualityRole: 'IPQC',
  designation: '',
  departmentId: '',
  shiftId: '',
  phone: '',
  password: '',
  isActive: true,
  appAccess: true,
}

export const WorkersPage: React.FC = () => {
  const { user: me, can } = useAuth()
  const canEdit = can('workers', 'manage')
  const allowedRoles = manageableRoles(me?.role)
  const canEditUser = (u: User) => allowedRoles.includes(u.role)
  const notify = useToast()
  const usersApi = useApi<User[]>('/api/users')
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
  // Permanent delete of an account and its history: the Super Admin only (Delete Users is never
  // granted to anyone else, and the server checks it again on every request).
  const canDeleteUsers = useDeletePermissions().DELETE_USERS
  const myId = me?.id
  const canDeleteUser = useCallback((u: User) => canDeleteUsers && u.id !== myId, [canDeleteUsers, myId])
  const [deleting, setDeleting] = useState<{ ids: string[]; bulk: boolean; user?: User } | null>(null)

  const users = useMemo(() => usersApi.data ?? [], [usersApi.data])
  const departments = departmentsApi.data ?? []
  const shifts = shiftsApi.data ?? []

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const counts = useMemo(() => {
    const c: Record<RoleTab, number> = { ALL: users.length, WORKER: 0, MANAGER: 0, ADMIN: 0, SUPER_ADMIN: 0 }
    for (const u of users) c[u.role]++
    return c
  }, [users])

  // The KPI strip, worked out from the list already loaded.
  const kpi = useMemo(() => {
    const k = { active: 0, noApp: 0, ipqc: 0, qc: 0, both: 0 }
    for (const u of users) {
      if (u.isActive) k.active++
      if (!u.appAccess) k.noApp++
      if (u.role === 'WORKER') {
        const q = u.workerQualityRole ?? 'IPQC'
        if (q === 'IPQC') k.ipqc++
        else if (q === 'QC') k.qc++
        else k.both++
      }
    }
    return k
  }, [users])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (tab !== 'ALL' && u.role !== tab) return false
      if (!q) return true
      return [u.name, u.employeeId, u.designation, u.departmentName, u.shiftName, u.phone].some((v) => v?.toLowerCase().includes(q))
    })
  }, [users, tab, search])

  const paging = usePagination(filtered, 25, `${tab}|${search}`)
  // Only the rows on this page can be selected, so nothing out of sight is ever deleted.
  const selection = useSelection(useMemo(() => paging.visible.filter(canDeleteUser).map((u) => u.id), [paging.visible, canDeleteUser]))

  const isSelf = editing !== null && editing !== 'new' && editing.id === me?.id
  // Only the Super Admin manages passwords: other users' here, their own in My Account.
  const canResetPassword = me?.role === 'SUPER_ADMIN' && !isSelf

  const openNew = () => {
    setForm({ ...emptyForm, role: tab !== 'ALL' && allowedRoles.includes(tab) ? tab : 'WORKER', workerQualityRole: 'IPQC' })
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (u: User) => {
    setForm({
      employeeId: u.employeeId,
      name: u.name,
      role: u.role,
      workerQualityRole: u.workerQualityRole ?? 'IPQC',
      designation: u.designation ?? '',
      departmentId: u.departmentId ?? '',
      shiftId: u.shiftId ?? '',
      phone: u.phone ?? '',
      password: '',
      isActive: u.isActive,
      appAccess: u.appAccess,
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
      const body = {
        employeeId: form.employeeId.trim(),
        name: form.name.trim(),
        role: form.role,
        workerQualityRole: form.workerQualityRole,
        designation: form.designation.trim() || null,
        departmentId: form.departmentId || null,
        shiftId: form.shiftId || null,
        phone: form.phone.trim() || null,
        isActive: form.isActive,
        // Only meaningful for workers; keep the stored value for others (turning it off would sign them out).
        appAccess: form.appAccess,
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
  const pickerError = departmentsApi.error || shiftsApi.error

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Users className="w-4.5 h-4.5" />}
        title="Workers & Users"
        description={usersApi.data ? `${users.length} ${users.length === 1 ? 'account' : 'accounts'} · ${kpi.active} active` : 'Shop-floor workers, managers and administrators'}
        info="Accounts for shop-floor workers, managers and administrators. Workers sign in to the mobile app with their employee ID; managers and admins use this web console."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add User
            </Button>
          )
        }
      />

      <DataState
        loading={usersApi.loading}
        error={usersApi.error}
        onRetry={usersApi.reload}
        // Once loaded, the table stays on screen while it reloads (e.g. after a save).
        empty={usersApi.data ? false : undefined}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <StatCard
            label="Accounts"
            value={users.length}
            icon={<Users className="w-4 h-4" />}
            meta={`${counts.WORKER} ${counts.WORKER === 1 ? 'worker' : 'workers'} · ${users.length - counts.WORKER} staff`}
          />
          <StatCard
            label="Active"
            value={kpi.active}
            icon={<UserCheck className="w-4 h-4" />}
            tone="success"
            meta={users.length - kpi.active > 0 ? `${users.length - kpi.active} disabled` : 'None disabled'}
          />
          <StatCard label="Workers" value={counts.WORKER} icon={<HardHat className="w-4 h-4" />} tone="accent" meta={`${kpi.ipqc} IPQC · ${kpi.qc} QC · ${kpi.both} both`} />
          <StatCard
            label="Managers & admins"
            value={counts.MANAGER + counts.ADMIN + counts.SUPER_ADMIN}
            icon={<ShieldCheck className="w-4 h-4" />}
            meta={`${counts.MANAGER} ${counts.MANAGER === 1 ? 'manager' : 'managers'} · ${counts.ADMIN + counts.SUPER_ADMIN} ${counts.ADMIN + counts.SUPER_ADMIN === 1 ? 'admin' : 'admins'}`}
          />
          <StatCard
            label="No app access"
            value={kpi.noApp}
            icon={<Smartphone className="w-4 h-4" />}
            tone={kpi.noApp > 0 ? 'exception' : 'neutral'}
            meta="Blocked from the mobile app"
          />
        </div>

        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search workers and users" placeholder="Name, ID, department…" />
            <Segmented<RoleTab>
              label="Filter by role"
              value={tab}
              onChange={setTab}
              options={TABS.filter((t) => t.value === 'ALL' || counts[t.value] > 0 || allowedRoles.includes(t.value as Role)).map((t) => ({
                value: t.value,
                label: t.label,
                count: counts[t.value]
              }))}
            />
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={users.length} noun={users.length === 1 ? 'user' : 'users'} />
          </Toolbar>

          {canDeleteUsers && selection.selected.length > 0 && (
            <div className="px-3 py-2.5 border-b border-line">
              <BulkDeleteBar
                count={selection.selected.length}
                noun={selection.selected.length === 1 ? 'user' : 'users'}
                onClear={selection.clear}
                onDelete={() => setDeleting({ ids: selection.selected, bulk: true })}
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Users className="w-5 h-5" />}
              title={users.length === 0 ? 'No users yet' : 'No users match the filters'}
              hint={users.length === 0 ? undefined : 'Try another role or search term'}
              action={
                users.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearch('')
                      setTab('ALL')
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    {canDeleteUsers && (
                      <th className="w-8 !pr-0">
                        <RowCheckbox checked={selection.allChecked} indeterminate={selection.partial} onChange={selection.toggleAll} label="Select all users shown" />
                      </th>
                    )}
                    <th>User</th>
                    <th>Role</th>
                    <th className="hidden xl:table-cell">Department</th>
                    <th>Access</th>
                    <th className="hidden xl:table-cell">Last login</th>
                    {(canEdit || canDeleteUsers) && (
                      <th className="text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {paging.visible.map((u) => {
                    const self = u.id === me?.id
                    return (
                      <tr key={u.id}>
                        {canDeleteUsers && (
                          <td className="w-8 !pr-0" data-label="Select">
                            {canDeleteUser(u) && <RowCheckbox checked={selection.isSelected(u.id)} onChange={() => selection.toggle(u.id)} label={`Select ${u.name}`} />}
                          </td>
                        )}
                        <td>
                          <div className="flex items-center gap-2.5 min-w-0">
                            <UserAvatar name={u.name} muted={!u.isActive} />
                            <div className="min-w-0 text-left">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className={`font-semibold truncate ${u.isActive ? 'text-ink' : 'text-ink-muted'}`}>{u.name}</span>
                                {self && <Pill className="bg-accent-soft text-accent-strong ring-accent-line">You</Pill>}
                              </div>
                              <div className="text-[11.5px] text-ink-muted truncate">
                                <span className="font-mono">{u.employeeId}</span>
                                {u.designation ? ` · ${u.designation}` : ''}
                              </div>
                              {/* Tablets and small laptops: the Department column is folded in here. */}
                              {(u.departmentName || u.shiftName) && (
                                <div className="hidden md:block xl:hidden text-[11.5px] text-ink-muted truncate">
                                  {[u.departmentName, u.shiftName].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          {/* Stacked on tablets so the row actions stay in view. */}
                          <div className="inline-flex flex-col items-end md:items-start lg:flex-row lg:items-center gap-1 lg:gap-1.5">
                            <RoleBadge role={u.role} />
                            {u.role === 'WORKER' && <QualityRoleBadge role={u.workerQualityRole ?? 'IPQC'} />}
                          </div>
                        </td>
                        <td className="hidden xl:table-cell whitespace-nowrap" data-empty={!u.departmentName && !u.shiftName ? '' : undefined}>
                          <div className={u.departmentName ? 'text-ink' : 'text-ink-faint'}>{u.departmentName ?? '—'}</div>
                          {u.shiftName && (
                            <div className="flex items-center gap-1 text-[11.5px] text-ink-muted">
                              <Clock3 className="w-3 h-3 shrink-0" aria-hidden />
                              {u.shiftName}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <StatusBadge status={u.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                            <AppAccessBadge allowed={u.appAccess} />
                          </div>
                          {/* Tablets and small laptops: the Last login column is folded in here. */}
                          <div className="hidden md:block xl:hidden mt-0.5 text-[11.5px] text-ink-muted tabular-nums">
                            Last login {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'never'}
                          </div>
                        </td>
                        <td className="hidden xl:table-cell whitespace-nowrap text-ink-secondary tabular-nums">
                          {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="text-ink-faint">Never</span>}
                        </td>
                        {(canEdit || canDeleteUsers) && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex items-center gap-0.5">
                              {canEditUser(u) && (
                                <IconButton label={`Edit ${u.name}`} onClick={() => openEdit(u)}>
                                  <Pencil className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                              {canViewPasswords && (
                                <IconButton label={`View password of ${u.name}`} onClick={() => setRevealing(u)}>
                                  <KeyRound className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                              {u.isActive && !self && canEditUser(u) && (
                                <IconButton label={`Disable ${u.name}`} tone="danger" onClick={() => setDisabling(u)}>
                                  <UserX className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                              {canDeleteUser(u) && (
                                <IconButton label={`Delete ${u.name} permanently`} tone="danger" onClick={() => setDeleting({ ids: [u.id], bulk: false, user: u })}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </IconButton>
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
          )}
          <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="users" />
        </Card>
      </DataState>

      <ShiftSignInStatusCard />

      {me?.role === 'SUPER_ADMIN' && <AdminDeletePermissions key={usersApi.data?.filter((u) => u.role === 'ADMIN').map((u) => u.id).join()} />}

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
            {form.role === 'WORKER' && (
              <Field label="Quality Role" required hint="Determines IPQC, QC, or both IPQC + QC check schedules, parameters, and notifications">
                <Select value={form.workerQualityRole} onChange={(e) => set('workerQualityRole', e.target.value as WorkerQualityRole)}>
                  <option value="IPQC">IPQC</option>
                  <option value="QC">QC</option>
                  <option value="BOTH">IPQC + QC (Both)</option>
                </Select>
              </Field>
            )}
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
            <div className="flex items-start gap-1.5 text-[11px] text-ink-muted">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                Workers receive schedule-based quality check notifications and perform checks for IPQC, QC, or both according to their assigned Quality Role.
              </span>
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
            longer sign in. Their check history and name stay on every record; you can re-enable them later from Edit.
          </>
        }
        onConfirm={disable}
        onClose={() => setDisabling(null)}
      />
      <RevealPasswordModal user={revealing} onClose={() => setRevealing(null)} />
      <DeleteRecordsModal
        type={deleting ? 'users' : null}
        ids={deleting?.ids ?? []}
        bulk={deleting?.bulk}
        onClose={() => setDeleting(null)}
        onDeleted={(r) => {
          notify('success', r.deleted === 1 ? 'User deleted' : `${r.deleted} users deleted`, 'The deletion is recorded in the audit log.')
          selection.clear()
          usersApi.reload()
        }}
      />
    </div>
  )
}
