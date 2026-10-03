import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { DELETE_PERMISSIONS, DELETE_PERMISSION_LABEL, type DeletePermission, type DeletePermissions } from '../deletion'
import { AccessDenied, Badge, Card, DataState, Notice, Screen, SmallButton, ToggleField, confirm, useToast } from '../ui'

// Same data and rules as the web panel's "Admin delete permissions" (admin-web/src/pages/admin/AdminDeletePermissions.tsx).

interface AdminRow {
  id: string
  employeeId: string
  name: string
  designation: string | null
  isActive: boolean
  deletePermissions: DeletePermissions
}

/** What each permission lets the Admin delete, in the confirmation sentence. */
const OBJECT: Record<DeletePermission, string> = { DELETE_USERS: 'Users', DELETE_JOBS: 'Jobs', DELETE_CHECKS: 'Checks' }
const NONE: DeletePermissions = { DELETE_USERS: false, DELETE_JOBS: false, DELETE_CHECKS: false }
const same = (a: DeletePermissions, b: DeletePermissions) => DELETE_PERMISSIONS.every((p) => a[p] === b[p])

/**
 * Super Admin only: which Admins may permanently delete Users, Jobs and Checks. The Super Admin
 * always has all three; Managers and Workers can never be given them. The backend enforces this
 * (PUT /api/access/admins/:id/delete-permissions) and audits every grant and revoke.
 */
const AdminDeletePermissionsScreen: React.FC = () => {
  const { profile } = useStaff()
  const notify = useToast()
  const superAdmin = profile.role === 'SUPER_ADMIN'
  const adminsApi = useQuery<AdminRow[]>(superAdmin ? '/api/access/admins' : null)
  const admins = useMemo(() => adminsApi.data ?? [], [adminsApi.data])
  const [drafts, setDrafts] = useState<Record<string, DeletePermissions>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    setDrafts(Object.fromEntries(admins.map((a) => [a.id, { ...a.deletePermissions }])))
  }, [admins])

  if (!superAdmin) {
    return (
      <Screen title="Admin delete permissions">
        <AccessDenied title="Only the Super Admin can manage delete permissions." />
      </Screen>
    )
  }

  const save = async (admin: AdminRow, next: DeletePermissions) => {
    const changes = DELETE_PERMISSIONS.filter((p) => admin.deletePermissions[p] !== next[p])
    if (!changes.length) return
    const sentence = (p: DeletePermission) =>
      next[p] ? `allow this Admin to permanently delete ${OBJECT[p]}` : `stop this Admin from permanently deleting ${OBJECT[p]}`
    const message =
      changes.length === 1
        ? `Are you sure you want to ${sentence(changes[0])}?\n\n${admin.name} (${admin.employeeId})`
        : `Are you sure you want to change these permissions for ${admin.name} (${admin.employeeId})?\n\n${changes
            .map((p) => `• ${DELETE_PERMISSION_LABEL[p]}: ${next[p] ? 'ON' : 'OFF'}`)
            .join('\n')}`
    const ok = await confirm('Change delete permissions?', message, 'Yes, change', changes.some((p) => next[p]))
    if (!ok) return
    setSaving(admin.id)
    try {
      await api.put(`/api/access/admins/${admin.id}/delete-permissions`, { permissions: Object.fromEntries(changes.map((p) => [p, next[p]])) })
      notify('success', 'Delete permissions saved', `${admin.name}. The change is recorded in the audit log.`)
      adminsApi.reload()
    } catch (err) {
      notify('error', 'Could not save delete permissions', errorText(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <Screen title="Admin delete permissions" subtitle="Which Admins may permanently delete test users, jobs and quality checks" onRefresh={adminsApi.reload} refreshing={adminsApi.loading && !!adminsApi.data}>
      <Notice
        icon="shield-outline"
        message="You always have all three permissions. Managers and Workers can never delete permanently. Every change is recorded in the audit log."
      />
      <DataState
        loading={adminsApi.loading}
        error={adminsApi.error}
        onRetry={adminsApi.reload}
        hasData={!!adminsApi.data}
        empty={!!adminsApi.data && admins.length === 0}
        emptyText="There are no Admin accounts."
        emptyIcon="people-outline"
      >
        <View className="gap-4">
          {admins.map((a) => {
            const draft = drafts[a.id] ?? a.deletePermissions
            const changed = !same(draft, a.deletePermissions)
            const anyGranted = DELETE_PERMISSIONS.some((p) => a.deletePermissions[p])
            return (
              <Card key={a.id} className="gap-3 p-4">
                <View className="flex-row items-center gap-2">
                  <Text className="flex-1 text-[16px] font-semibold text-staff-ink" numberOfLines={1}>
                    {a.name} <Text className="font-normal text-staff-muted">{a.employeeId}</Text>
                  </Text>
                  {!a.isActive ? <Badge label="Disabled" tone="missed" /> : null}
                </View>
                {DELETE_PERMISSIONS.map((p) => (
                  <ToggleField
                    key={p}
                    label={`${DELETE_PERMISSION_LABEL[p]} for ${a.name}`}
                    description={draft[p] ? 'ON' : 'OFF'}
                    value={draft[p]}
                    onChange={(v) => setDrafts((d) => ({ ...d, [a.id]: { ...(d[a.id] ?? a.deletePermissions), [p]: v } }))}
                  />
                ))}
                <View className="flex-row gap-2">
                  <SmallButton label="Save" tone="primary" onPress={() => save(a, draft)} disabled={!changed} loading={saving === a.id} className="flex-1" />
                  <SmallButton label="Revoke all" onPress={() => save(a, NONE)} disabled={!anyGranted || saving === a.id} className="flex-1" />
                </View>
              </Card>
            )
          })}
        </View>
      </DataState>
    </Screen>
  )
}

export const DELETE_PERMISSIONS_SCREENS = {
  adminDeletePermissions: AdminDeletePermissionsScreen
}
