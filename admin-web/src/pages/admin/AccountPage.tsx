import React, { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, UserRound } from 'lucide-react'
import type { ModuleInfo } from '../../types'
import { changePassword, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ROLE_LABEL, useAuth } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { PageHeader } from '../../components/common/PageHeader'
import { Section } from '../../components/common/Section'
import { useToast } from '../../components/common/Toast'

/** The signed-in user's own account: who they are, what they may use, and their password. */
export const AccountPage: React.FC = () => {
  const { user, isAdmin, refresh } = useAuth()
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

  if (!user) return null

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
    <div className="space-y-4 max-w-3xl">
      <PageHeader title="My Account" description="Your profile, what you have access to, and your password" />

      <Section icon={<UserRound className="w-4 h-4" />} title="Profile">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-ink-muted">Name</dt>
          <dd className="text-ink font-medium">{user.name}</dd>
          <dt className="text-ink-muted">Employee ID</dt>
          <dd className="font-mono text-ink">{user.employeeId}</dd>
          <dt className="text-ink-muted">Role</dt>
          <dd className="text-ink">{ROLE_LABEL[user.role]}</dd>
          {user.designation && (
            <>
              <dt className="text-ink-muted">Designation</dt>
              <dd className="text-ink">{user.designation}</dd>
            </>
          )}
        </dl>
      </Section>

      <Section
        icon={<ShieldCheck className="w-4 h-4" />}
        title="My access"
        description={isAdmin ? 'Admins have full access to every module' : 'Set by an Admin. Ask an Admin if you need access to another module.'}
      >
        {isAdmin ? (
          <p className="text-xs text-ink-secondary">You can view and manage every module, user accounts and manager permissions.</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded text-xs">
            {(modules.data ?? []).map((m) => {
              const access = user.permissions[m.key]
              return (
                <li key={m.key} className="px-3 py-2 flex items-center justify-between gap-3">
                  <span className="text-ink font-medium">{m.label}</span>
                  <AccessBadge access={access} />
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section icon={<KeyRound className="w-4 h-4" />} title="Change my password" description={`Signed in as ${user.name} (${user.employeeId})`}>
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
      </Section>
    </div>
  )
}

export const AccessBadge: React.FC<{ access: 'none' | 'view' | 'manage' }> = ({ access }) => (
  <span
    className={`px-1.5 py-0.5 rounded border text-[11px] font-medium whitespace-nowrap ${
      access === 'manage'
        ? 'bg-success-bg text-success border-success-line'
        : access === 'view'
          ? 'bg-due-bg text-due border-due-line'
          : 'bg-subtle text-ink-muted border-line'
    }`}
  >
    {access === 'manage' ? 'View & manage' : access === 'view' ? 'View only' : 'No access'}
  </span>
)
