import React, { useEffect, useMemo, useState } from 'react'
import { Check, Edit2, Eye, KeyRound, Plus, Power, RotateCcw, ShieldCheck, X } from 'lucide-react'
import type { Access, ManagerAccess, ModuleInfo, ModuleKey, Permissions, User } from '../../types'
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

const LEVELS: { value: Access; label: string; icon: React.ReactNode }[] = [
  { value: 'none', label: 'No access', icon: <X className="w-3 h-3" /> },
  { value: 'view', label: 'View', icon: <Eye className="w-3 h-3" /> },
  { value: 'manage', label: 'Manage', icon: <Check className="w-3 h-3" /> }
]

const sameAccess = (a: Permissions, b: Permissions) => (Object.keys(a) as ModuleKey[]).every((k) => a[k] === b[k])
const grantedCount = (p: Permissions) => Object.values(p).filter((a) => a !== 'none').length

interface AccountForm {
  employeeId: string
  name: string
  designation: string
  password: string
  isActive: boolean
}

/**
 * Admins decide which modules each Manager can view or manage. The backend checks the same
 * permissions on every request, so hiding a page here is not the only protection.
 */
export const ManagerAccessPage: React.FC = () => {
  const notify = useToast()
  // Only the Super Admin may reset another user's password.
  const canResetPassword = useAuth().user?.role === 'SUPER_ADMIN'
  const modulesApi = useApi<ModuleInfo[]>('/api/access/modules')
  const managersApi = useApi<ManagerAccess[]>('/api/access/managers')
  // Full account records, needed to edit a manager's details.
  const accountsApi = useApi<User[]>('/api/users', { role: 'MANAGER' })

  const modules = useMemo(() => modulesApi.data ?? [], [modulesApi.data])
  const managers = useMemo(() => managersApi.data ?? [], [managersApi.data])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Permissions | null>(null)
  const [saving, setSaving] = useState(false)
  const [account, setAccount] = useState<{ editing: User | 'new'; form: AccountForm } | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [savingAccount, setSavingAccount] = useState(false)
  const [toggling, setToggling] = useState<ManagerAccess | null>(null)
  const [revealing, setRevealing] = useState<ManagerAccess | null>(null)

  const selected = managers.find((m) => m.id === selectedId) ?? null

  // Pick the first manager once loaded, and reset the draft whenever the selection changes.
  useEffect(() => {
    if (!selectedId && managers.length) setSelectedId(managers[0].id)
  }, [managers, selectedId])
  useEffect(() => {
    setDraft(selected ? { ...selected.permissions } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, managersApi.data])

  const dirty = !!(selected && draft && !sameAccess(selected.permissions, draft))

  const setLevel = (module: ModuleInfo, level: Access) => {
    if (!draft) return
    setDraft({ ...draft, [module.key]: level === 'manage' && module.viewOnly ? 'view' : level })
  }
  const setAll = (level: Access) => {
    if (!draft) return
    setDraft(Object.fromEntries(modules.map((m) => [m.key, level === 'manage' && m.viewOnly ? 'view' : level])) as Permissions)
  }

  const choose = (id: string) => {
    if (dirty && !window.confirm('You have unsaved permission changes. Discard them?')) return
    setSelectedId(id)
  }

  const save = async () => {
    if (!selected || !draft) return
    setSaving(true)
    try {
      await api.put(`/api/access/managers/${selected.id}`, { permissions: draft })
      notify('success', 'Permissions saved', `${selected.name} gets the new access on their next click.`)
      await managersApi.reload()
    } catch (err) {
      notify('error', 'Could not save permissions', errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const openNewManager = () => {
    setAccountError(null)
    setAccount({ editing: 'new', form: { employeeId: '', name: '', designation: '', password: '', isActive: true } })
  }
  const openEditManager = (m: ManagerAccess) => {
    const record = accountsApi.data?.find((u) => u.id === m.id)
    if (!record) return
    setAccountError(null)
    setAccount({
      editing: record,
      form: { employeeId: record.employeeId, name: record.name, designation: record.designation ?? '', password: '', isActive: record.isActive }
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
      appAccess: false,
      machineIds: [],
      ...(form.password ? { password: form.password } : {})
    }

    setSavingAccount(true)
    setAccountError(null)
    try {
      if (creating) {
        const created = await api.post<User>('/api/users', body)
        notify('success', 'Manager created', `${created.name} has no access yet. Choose their modules and save.`)
        setSelectedId(created.id)
      } else {
        await api.put(`/api/users/${editing.id}`, body)
        notify('success', 'Manager updated', body.name)
      }
      setAccount(null)
      await Promise.all([managersApi.reload(), accountsApi.reload()])
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
          appAccess: false,
          machineIds: []
        })
        notify('success', 'Manager activated', `${toggling.name} can sign in again with the same access.`)
      }
      await Promise.all([managersApi.reload(), accountsApi.reload()])
    } catch (err) {
      notify('error', 'Could not change the account', errorText(err))
    }
  }

  const setForm = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) =>
    setAccount((a) => (a ? { ...a, form: { ...a.form, [key]: value } } : a))

  return (
    <div className="space-y-4">
      <PageHeader
        title="Manager Access"
        description="Choose which modules each Manager can view or manage. Changes apply on the manager's next click."
        actions={
          <Button size="sm" variant="primary" onClick={openNewManager} icon={<Plus className="w-3.5 h-3.5" />}>
            Add Manager
          </Button>
        }
      />

      <DataState
        loading={managersApi.loading || modulesApi.loading}
        error={managersApi.error || modulesApi.error}
        onRetry={() => {
          managersApi.reload()
          modulesApi.reload()
        }}
        empty={!managersApi.loading && managers.length === 0}
        emptyText="No managers yet. Add a manager, then choose the modules they can use."
      >
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
          {/* Managers */}
          <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden" aria-label="Managers">
            <div className="px-3 py-2 border-b border-line bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
              Managers · {managers.length}
            </div>
            <ul className="divide-y divide-line max-h-[60vh] overflow-y-auto">
              {managers.map((m) => {
                const active = m.id === selectedId
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => choose(m.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                        active ? 'bg-subtle border-l-2 border-accent pl-2.5' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className={`block text-[13px] lg:text-xs font-semibold truncate ${m.isActive ? 'text-ink' : 'text-ink-muted'}`}>{m.name}</span>
                        <span className="block text-[11px] text-ink-muted font-mono truncate">
                          {m.employeeId}
                          {m.designation ? ` · ${m.designation}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 flex flex-col items-end gap-1">
                        {!m.isActive && <StatusBadge status="DISABLED" size="sm" />}
                        <span className="text-[11px] text-ink-muted whitespace-nowrap">
                          {grantedCount(m.permissions)} of {modules.length}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Permissions of the selected manager */}
          {selected && draft && (
            <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden" aria-label={`Permissions for ${selected.name}`}>
              <div className="px-4 py-3 border-b border-line bg-slate-50 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-ink flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-accent" />
                    {selected.name}
                  </h2>
                  <p className="text-[11px] text-ink-muted">
                    {selected.isActive ? 'Active' : 'Deactivated'} · last sign-in {selected.lastLoginAt ? formatDateTime(selected.lastLoginAt) : 'never'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => openEditManager(selected)} icon={<Edit2 className="w-3 h-3" />} disabled={!accountsApi.data}>
                    Edit account
                  </Button>
                  {canResetPassword && (
                    <Button size="sm" variant="outline" onClick={() => setRevealing(selected)} icon={<KeyRound className="w-3 h-3" />}>
                      View password
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={selected.isActive ? 'ghost' : 'outline'}
                    onClick={() => setToggling(selected)}
                    icon={<Power className={`w-3 h-3 ${selected.isActive ? 'text-failed' : 'text-success'}`} />}
                  >
                    {selected.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              </div>

              <div className="px-4 py-2 border-b border-line flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                <span>Set all:</span>
                <Button size="sm" variant="ghost" onClick={() => setAll('none')}>
                  No access
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAll('view')}>
                  View all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAll('manage')}>
                  Manage all
                </Button>
              </div>

              <ul className="divide-y divide-line">
                {modules.map((m) => {
                  const level = draft[m.key]
                  const changed = level !== selected.permissions[m.key]
                  return (
                    <li key={m.key} className={`px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${changed ? 'bg-due-bg/50' : ''}`}>
                      <div className="min-w-0">
                        <div className="text-[13px] lg:text-xs font-semibold text-ink">
                          {m.label}
                          {changed && <span className="ml-1.5 text-[11px] font-medium text-due">changed</span>}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {m.description}
                          {m.viewOnly ? ' · view only' : ''}
                        </div>
                      </div>
                      <div role="radiogroup" aria-label={`${m.label} access`} className="grid grid-cols-3 sm:inline-flex shrink-0 rounded border border-line-strong overflow-hidden">
                        {LEVELS.map((l) => {
                          const disabled = l.value === 'manage' && m.viewOnly
                          const on = level === l.value
                          return (
                            <button
                              key={l.value}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              disabled={disabled}
                              onClick={() => setLevel(m, l.value)}
                              title={disabled ? `${m.label} has nothing to manage` : undefined}
                              className={`h-[40px] lg:h-7 px-2.5 inline-flex items-center justify-center gap-1 text-[12px] lg:text-[11px] font-medium whitespace-nowrap border-r border-line last:border-r-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                on
                                  ? l.value === 'none'
                                    ? 'bg-slate-700 text-white'
                                    : l.value === 'view'
                                      ? 'bg-due text-white'
                                      : 'bg-success text-white'
                                  : 'bg-white text-ink-secondary hover:bg-slate-50'
                              }`}
                            >
                              {l.icon}
                              {l.label}
                            </button>
                          )
                        })}
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="sticky bottom-0 px-4 py-3 border-t border-line bg-slate-50 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-ink-muted">
                  {dirty ? 'Unsaved changes' : `${grantedCount(selected.permissions)} of ${modules.length} modules granted`}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setDraft({ ...selected.permissions })} disabled={!dirty || saving} icon={<RotateCcw className="w-3 h-3" />}>
                    Undo
                  </Button>
                  <Button size="sm" variant="primary" onClick={save} disabled={!dirty} loading={saving}>
                    Save permissions
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
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
              {(account.editing === 'new' || canResetPassword) && (
                <Field
                  label={account.editing === 'new' ? 'Password' : 'New password'}
                  required={account.editing === 'new'}
                  hint={account.editing === 'new' ? 'At least 6 characters' : 'Leave blank to keep the current password'}
                >
                  <TextInput type="password" value={account.form.password} onChange={(e) => setForm('password', e.target.value)} autoComplete="new-password" />
                </Field>
              )}
            </div>
            {account.editing !== 'new' && !canResetPassword && (
              <p className="text-[11px] text-ink-muted">Only the Super Admin can change this manager's password.</p>
            )}
            <Toggle checked={account.form.isActive} onChange={(v) => setForm('isActive', v)} label="Active" description="Deactivated managers cannot sign in" />
            {account.editing === 'new' && (
              <p className="text-[11px] text-ink-muted">A new manager has no access until you choose their modules and save.</p>
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
            ? `${toggling?.name} will be signed out now and cannot sign in until activated again. Their permissions are kept.`
            : `${toggling?.name} can sign in again with the permissions they had.`
        }
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Activate'}
        danger={toggling?.isActive}
        onConfirm={toggleActive}
        onClose={() => setToggling(null)}
      />
    </div>
  )
}
