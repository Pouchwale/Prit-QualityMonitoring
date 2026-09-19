import React, { useState } from 'react'
import { Text } from 'react-native'
import type { ModuleInfo } from '../types'
import { getApiUrl, changePassword } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { ROLE_LABEL } from '../format'
import { ActionList, ActionRow, Badge, DataState, FormError, FormSection, Input, KV, List, Notice, PrimaryButton, ProfileCard, Row, Screen, Section, confirm, useToast } from '../ui'

/** The signed-in user's account. Only the Super Admin can change a password (enforced by the backend). */
export const AccountScreen: React.FC = () => {
  const { profile, isAdmin, isSuperAdmin, signOut } = useStaff()
  const notify = useToast()
  const modules = useQuery<ModuleInfo[]>(isAdmin ? null : '/api/access/modules')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!current) return setError('Enter your current password')
    if (next.length < 6) return setError('New password must be at least 6 characters')
    if (next !== again) return setError('New password and confirmation do not match')
    if (next === current) return setError('New password must be different from the current one')
    setSaving(true)
    setError(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setAgain('')
      notify('success', 'Password changed', 'Other devices signed in with your account have been signed out.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen title="My Account">
      <ProfileCard name={profile.name} role={ROLE_LABEL[profile.role]} employeeId={profile.employeeId} />

      <Section title="Personal info" small>
        <List>
          <KV label="Name" value={profile.name} />
          <KV label="Employee ID" value={profile.employeeId} />
          <KV label="Role" value={ROLE_LABEL[profile.role]} />
          {profile.designation ? <KV label="Designation" value={profile.designation} /> : null}
          {profile.departmentName ? <KV label="Department" value={profile.departmentName} /> : null}
        </List>
      </Section>

      <Section title="Your access" small detail={isAdmin ? 'Admins have full access to every module' : 'Set by an Admin'}>
        {isAdmin ? (
          <Notice tone="success" icon="shield-checkmark-outline" message="You can view and manage every module, user accounts and manager permissions." />
        ) : (
          <DataState loading={modules.loading} error={modules.error} onRetry={modules.reload} hasData={!!modules.data} empty={!!modules.data && modules.data.length === 0} emptyIcon="lock-closed-outline" emptyText="No modules listed.">
            <List>
              {(modules.data ?? []).map((m) => {
                const access = profile.permissions?.[m.key] ?? 'none'
                return (
                  <Row
                    key={m.key}
                    title={m.label}
                    right={<Badge label={access === 'manage' ? 'View & manage' : access === 'view' ? 'View only' : 'No access'} tone={access === 'manage' ? 'success' : 'neutral'} dot />}
                  />
                )
              })}
            </List>
          </DataState>
        )}
      </Section>

      {isSuperAdmin ? (
        <FormSection title="Change my password" description="Other devices signed in with your account will be signed out.">
          <FormError message={error} />
          <Input label="Current password" value={current} onChangeText={setCurrent} secure required />
          <Input label="New password" value={next} onChangeText={setNext} secure required hint="At least 6 characters" />
          <Input label="Confirm new password" value={again} onChangeText={setAgain} secure required />
          <PrimaryButton label="Change password" icon="key-outline" onPress={save} loading={saving} disabled={!current || !next || !again} />
        </FormSection>
      ) : null}

      <ActionList>
        <ActionRow
          icon="log-out-outline"
          label="Sign out"
          tone="danger"
          onPress={async () => {
            if (await confirm('Sign out?', 'You will need your employee ID and password to sign in again.', 'Sign out', true)) await signOut()
          }}
        />
      </ActionList>
      <Text className="-mt-3 px-4 text-[12px] leading-[16px] text-staff-muted">Server: {getApiUrl()}</Text>
    </Screen>
  )
}
