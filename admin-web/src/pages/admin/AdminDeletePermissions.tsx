import React, { useEffect, useMemo, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { DELETE_PERMISSIONS, DELETE_PERMISSION_LABEL, type DeletePermission, type DeletePermissions } from '../../lib/deletePermissions'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { askConfirm } from '../../components/common/AppDialog'

interface AdminRow {
  id: string
  employeeId: string
  name: string
  designation: string | null
  isActive: boolean
  deletePermissions: DeletePermissions
}

/** What each permission lets the Admin delete, in the confirmation sentence. */
const OBJECT: Record<DeletePermission, string> = {
  DELETE_USERS: 'Users',
  DELETE_JOBS: 'Jobs',
  DELETE_CHECKS: 'Checks'
}

const same = (a: DeletePermissions, b: DeletePermissions) => DELETE_PERMISSIONS.every((p) => a[p] === b[p])

/**
 * Super Admin only: which Admins may permanently delete Users, Jobs and Checks.
 *
 * The Super Admin always has every delete permission. Managers and Workers can never be given
 * them. The backend enforces all of this and records every grant and revoke in the audit log.
 */
export const AdminDeletePermissions: React.FC = () => {
  const notify = useToast()
  const adminsApi = useApi<AdminRow[]>('/api/access/admins')
  const admins = useMemo(() => adminsApi.data ?? [], [adminsApi.data])
  const [drafts, setDrafts] = useState<Record<string, DeletePermissions>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    setDrafts(Object.fromEntries(admins.map((a) => [a.id, { ...a.deletePermissions }])))
  }, [admins])

  const toggle = (id: string, p: DeletePermission) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [p]: !d[id][p] } }))

  const save = async (admin: AdminRow, next: DeletePermissions) => {
    const changes = DELETE_PERMISSIONS.filter((p) => admin.deletePermissions[p] !== next[p])
    if (!changes.length) return
    const sentence = (p: DeletePermission) =>
      next[p] ? `allow this Admin to permanently delete ${OBJECT[p]}` : `stop this Admin from permanently deleting ${OBJECT[p]}`
    const confirmed = await askConfirm({
      title: 'Change delete permissions?',
      danger: changes.some((p) => next[p]),
      message:
        changes.length === 1 ? (
          <>
            Are you sure you want to {sentence(changes[0])}?
            <br />
            <span className="text-ink-muted">
              {admin.name} ({admin.employeeId})
            </span>
          </>
        ) : (
          <>
            Are you sure you want to change these permissions for {admin.name} ({admin.employeeId})?
          </>
        ),
      items: changes.length > 1 ? changes.map((p) => ({ label: `${DELETE_PERMISSION_LABEL[p]}: ${next[p] ? 'ON' : 'OFF'}`, detail: sentence(p) })) : undefined,
      confirmLabel: 'Yes, change'
    })
    if (!confirmed) return
    setSaving(admin.id)
    try {
      await api.put(`/api/access/admins/${admin.id}/delete-permissions`, {
        permissions: Object.fromEntries(changes.map((p) => [p, next[p]]))
      })
      notify('success', 'Delete permissions saved', `${admin.name}. The change is recorded in the audit log.`)
      adminsApi.reload()
    } catch (err) {
      notify('error', 'Could not save delete permissions', errorText(err))
    } finally {
      setSaving(null)
    }
  }

  const none: DeletePermissions = { DELETE_USERS: false, DELETE_JOBS: false, DELETE_CHECKS: false }

  return (
    <section className="bg-white border border-line rounded-md shadow-2xs" aria-labelledby="admin-delete-permissions">
      <div className="flex items-start gap-2 px-3.5 py-3 border-b border-line">
        <ShieldAlert className="w-4 h-4 text-failed shrink-0 mt-0.5" />
        <div>
          <h2 id="admin-delete-permissions" className="text-sm font-semibold text-ink">
            Admin delete permissions
          </h2>
          <p className="text-[11px] text-ink-muted">
            Which Admins may permanently delete test users, jobs and quality checks. You always have all three. Managers and Workers can never delete
            permanently.
          </p>
        </div>
      </div>
      <DataState loading={adminsApi.loading} error={adminsApi.error} onRetry={adminsApi.reload} empty={!adminsApi.loading && admins.length === 0} emptyText="There are no Admin accounts.">
        <div className="overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Admin</th>
                {DELETE_PERMISSIONS.map((p) => (
                  <th key={p} className="py-2.5 px-3.5">
                    {DELETE_PERMISSION_LABEL[p]}
                  </th>
                ))}
                <th className="py-2.5 px-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {admins.map((a) => {
                const draft = drafts[a.id] ?? a.deletePermissions
                const changed = !same(draft, a.deletePermissions)
                const anyGranted = DELETE_PERMISSIONS.some((p) => a.deletePermissions[p])
                return (
                  <tr key={a.id}>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <span className="font-semibold text-ink">{a.name}</span>
                      <span className="ml-1.5 font-mono text-ink-muted">{a.employeeId}</span>
                      {!a.isActive && (
                        <span className="ml-1.5">
                          <StatusBadge status="DISABLED" size="sm" />
                        </span>
                      )}
                    </td>
                    {DELETE_PERMISSIONS.map((p) => (
                      <td key={p} className="py-2.5 px-3.5">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            role="switch"
                            className="w-4 h-4 accent-[var(--color-failed)]"
                            checked={draft[p]}
                            onChange={() => toggle(a.id, p)}
                            aria-label={`${DELETE_PERMISSION_LABEL[p]} for ${a.name}`}
                          />
                          <span className={draft[p] ? 'font-semibold text-failed' : 'text-ink-muted'}>{draft[p] ? 'ON' : 'OFF'}</span>
                        </label>
                      </td>
                    ))}
                    <td className="py-2 px-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        <Button size="sm" variant="primary" disabled={!changed} loading={saving === a.id} onClick={() => save(a, draft)}>
                          Save
                        </Button>
                        <Button size="sm" variant="outline" disabled={!anyGranted || saving === a.id} onClick={() => save(a, none)}>
                          Revoke all
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>
    </section>
  )
}
