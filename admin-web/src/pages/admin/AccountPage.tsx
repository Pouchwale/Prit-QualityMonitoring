import React, { useEffect, useMemo, useState } from 'react'
import { Building2, Check, Clock3, Eye, Hash, KeyRound, Lock, Minus, ShieldCheck, UserRound } from 'lucide-react'
import type { ModuleInfo } from '../../types'
import { changePassword, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ROLE_LABEL, useAuth } from '../../lib/auth'
import { formatClockRange } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader } from '../../components/ui/Card'
import { Pill, UserAvatar, RoleBadge } from '../../components/ui/Chips'

/** The signed-in user's own account: who they are and what they may use. Only the Super Admin manages passwords. */
export const AccountPage: React.FC = () => {
  const { user, isAdmin, isSuperAdmin, refresh } = useAuth()
  const notify = useToast()
  const modules = useApi<ModuleInfo[]>('/api/access/modules')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [savingPassword, setSavingPassword] = useState(false)

  // Show the latest permissions when the page is opened.
  useEffect(() => {
    refresh()
  }, [refresh])

  // How many modules this account can manage, only view, or not open.
  const summary = useMemo(() => {
    const s = { manage: 0, view: 0, none: 0 }
    if (user) for (const m of modules.data ?? []) s[user.permissions[m.key] ?? 'none']++
    return s
  }, [modules.data, user])

  if (!user) return null
  // Password management is Super Admin only (enforced by the backend as well).
  const canManagePasswords = user.role === 'SUPER_ADMIN'

  const savePassword = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!currentPassword) return setPasswordError('Enter your current password')
    if (newPassword.length < 6) return setPasswordError('New password must be at least 6 characters')
    if (newPassword !== confirmPassword) return setPasswordError('New password and confirmation do not match')
    if (newPassword === currentPassword) return setPasswordError('New password must be different from the current one')
    setSavingPassword(true)
    setPasswordError(null)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      notify('success', 'Password changed', 'Other devices signed in with your account have been signed out.')
    } catch (err) {
      setPasswordError(errorText(err))
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHeader
        icon={<UserRound className="w-4.5 h-4.5" />}
        title="My Account"
        description={canManagePasswords ? 'Your profile, access and password' : 'Your profile and access'}
        info={canManagePasswords ? 'Your profile, what you have access to, and your password.' : 'Your profile and what you have access to. Only the Super Admin manages passwords.'}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* Profile */}
        <Card className="overflow-hidden">
          <div className="px-4 pt-5 pb-4 flex flex-col items-center text-center border-b border-line">
            <UserAvatar name={user.name} size="lg" />
            <h2 className="mt-3 text-[15px] font-semibold text-ink leading-tight">{user.name}</h2>
            {user.designation && <p className="text-[12px] text-ink-muted mt-0.5">{user.designation}</p>}
            <div className="mt-2.5">
              <RoleBadge role={user.role} />
            </div>
          </div>
          <dl className="px-4 py-3 space-y-2.5 text-[12.5px]">
            <ProfileRow icon={<Hash className="w-3.5 h-3.5" />} label="Employee ID">
              <span className="font-mono">{user.employeeId}</span>
            </ProfileRow>
            <ProfileRow icon={<ShieldCheck className="w-3.5 h-3.5" />} label="Role">
              {ROLE_LABEL[user.role]}
            </ProfileRow>
            <ProfileRow icon={<Building2 className="w-3.5 h-3.5" />} label="Department">
              {user.departmentName ?? <span className="text-ink-faint">None</span>}
            </ProfileRow>
            {user.shiftName && (
              <ProfileRow icon={<Clock3 className="w-3.5 h-3.5" />} label="Shift">
                {user.shiftName}
                {user.shiftStartTime && user.shiftEndTime && (
                  <span className="block text-[11.5px] text-ink-muted tabular-nums">{formatClockRange(user.shiftStartTime, user.shiftEndTime)}</span>
                )}
              </ProfileRow>
            )}
          </dl>
        </Card>

        <div className="lg:col-span-2 space-y-4">
          {/* Access */}
          <Card>
            <CardHeader
              icon={<ShieldCheck className="w-4 h-4" />}
              title="My access"
              subtitle={isAdmin ? 'Admins have full access to every module' : 'Set by the Super Admin, the same for every Manager'}
              info={isAdmin ? undefined : 'Set by the Super Admin, the same for every Manager. Ask the Super Admin if you need access to another module.'}
            />
            <div className="p-4">
              {isAdmin ? (
                <div className="flex items-start gap-3">
                  <AccessBadge access="manage" />
                  <p className="text-[12.5px] text-ink-secondary">
                    {isSuperAdmin
                      ? 'You can view and manage every module and every account, and you decide what Managers can use.'
                      : 'You can view and manage every module, and the Manager and Worker accounts. Only the Super Admin decides what Managers can use.'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[12px] text-ink-muted">
                    <span>
                      <span className="font-semibold text-ink tabular-nums">{summary.manage}</span> manage
                    </span>
                    <span>
                      <span className="font-semibold text-ink tabular-nums">{summary.view}</span> view only
                    </span>
                    <span>
                      <span className="font-semibold text-ink tabular-nums">{summary.none}</span> no access
                    </span>
                  </div>
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {(modules.data ?? []).map((m) => {
                      const access = user.permissions[m.key]
                      return (
                        <li key={m.key} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-line ${access === 'none' ? 'bg-subtle' : 'bg-white'}`}>
                          <span className={`text-[12.5px] font-medium truncate ${access === 'none' ? 'text-ink-muted' : 'text-ink'}`}>{m.label}</span>
                          <AccessBadge access={access} viewOnly={m.viewOnly} />
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </div>
          </Card>

          {/* Security */}
          <Card>
            <CardHeader
              icon={<KeyRound className="w-4 h-4" />}
              title={canManagePasswords ? 'Change my password' : 'Password'}
              subtitle={canManagePasswords ? `Signed in as ${user.name} (${user.employeeId})` : 'Managed by the Super Admin'}
            />
            <div className="p-4">
              {canManagePasswords ? (
                <form onSubmit={savePassword} className="space-y-3 max-w-sm">
                  <FormError message={passwordError} />
                  <Field label="Current password" required>
                    <TextInput type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
                  </Field>
                  <Field label="New password" required hint="At least 6 characters">
                    <TextInput type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                  </Field>
                  <Field label="Confirm new password" required>
                    <TextInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                  </Field>
                  <Button size="sm" variant="primary" type="submit" loading={savingPassword} disabled={!currentPassword || !newPassword || !confirmPassword}>
                    Change password
                  </Button>
                </form>
              ) : (
                <p className="flex items-start gap-2 text-[12.5px] text-ink-secondary">
                  <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden />
                  Only the Super Admin can change passwords. Ask them if you need a new one.
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

const ProfileRow: React.FC<{ icon: React.ReactNode; label: string; children: React.ReactNode }> = ({ icon, label, children }) => (
  <div className="flex items-start gap-2.5">
    <span className="mt-0.5 text-ink-faint" aria-hidden>
      {icon}
    </span>
    <dt className="w-24 shrink-0 text-ink-muted">{label}</dt>
    <dd className="min-w-0 flex-1 text-ink font-medium">{children}</dd>
  </div>
)

/** A module with nothing to manage (e.g. Export Reports) is fully allowed with "view": no "only". */
export const AccessBadge: React.FC<{ access: 'none' | 'view' | 'manage'; viewOnly?: boolean }> = ({ access, viewOnly }) => (
  <Pill
    className={
      access === 'manage'
        ? 'bg-success-bg text-success ring-success-line'
        : access === 'view'
          ? 'bg-due-bg text-due ring-due-line'
          : 'bg-white text-ink-muted ring-line'
    }
  >
    {access === 'manage' ? <Check className="w-3 h-3" aria-hidden /> : access === 'view' ? <Eye className="w-3 h-3" aria-hidden /> : <Minus className="w-3 h-3" aria-hidden />}
    {access === 'manage' ? 'View & manage' : access === 'view' ? (viewOnly ? 'Allowed' : 'View only') : 'No access'}
  </Pill>
)
