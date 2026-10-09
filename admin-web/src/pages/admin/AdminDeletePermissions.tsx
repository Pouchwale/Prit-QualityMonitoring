import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Briefcase, ClipboardCheck, ShieldAlert } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { GRANTABLE_DELETE_PERMISSIONS, DELETE_PERMISSION_LABEL, type DeletePermission, type DeletePermissions } from '../../lib/deletePermissions'
import { Button } from '../../components/common/Button'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { askConfirm } from '../../components/common/AppDialog'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { UserAvatar } from '../../components/ui/Chips'

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

const ICON: Record<DeletePermission, React.ReactNode> = {
  DELETE_USERS: null,
  DELETE_JOBS: <Briefcase className="w-3.5 h-3.5" />,
  DELETE_CHECKS: <ClipboardCheck className="w-3.5 h-3.5" />
}

const same = (a: DeletePermissions, b: DeletePermissions) => GRANTABLE_DELETE_PERMISSIONS.every((p) => a[p] === b[p])

/**
 * Super Admin only: which Admins may permanently delete Jobs and Checks.
 *
 * The Super Admin always has every delete permission, and Delete Users is theirs alone. Managers
 * and Workers can never be given any. The backend enforces all of this and records every grant and revoke in the audit log.
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
    const changes = GRANTABLE_DELETE_PERMISSIONS.filter((p) => admin.deletePermissions[p] !== next[p])
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
    <Card aria-labelledby="admin-delete-permissions">
      <CardHeader
        icon={<ShieldAlert className="w-4 h-4 text-missed" />}
        title={<span id="admin-delete-permissions">Admin delete permissions</span>}
        subtitle="Which Admins may permanently delete test jobs and quality checks"
        info="Deleting users is for the Super Admin only and cannot be given to anyone. Managers and Workers can never delete permanently. Every grant and revoke is recorded in the audit log."
        actions={
          adminsApi.data && (
            <span className="h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full bg-subtle text-ink-muted ring-1 ring-inset ring-line text-[11px] font-semibold tabular-nums">
              {admins.length}
            </span>
          )
        }
      />
      {adminsApi.error ? (
        <EmptyState
          icon={<AlertCircle className="w-5 h-5" />}
          title="Could not load Admins"
          hint={adminsApi.error}
          compact
          action={
            <Button size="sm" variant="outline" onClick={adminsApi.reload}>
              Try again
            </Button>
          }
        />
      ) : adminsApi.data === null ? (
        <div className="p-4 space-y-2.5" role="status" aria-busy="true">
          <span className="sr-only">Loading…</span>
          {[70, 55].map((w) => (
            <div key={w} className="h-3 rounded bg-subtle animate-pulse" style={{ width: `${w}%` }} aria-hidden />
          ))}
        </div>
      ) : admins.length === 0 ? (
        <EmptyState icon={<ShieldAlert className="w-5 h-5" />} title="There are no Admin accounts." compact />
      ) : (
        <ul className="p-3 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {admins.map((a) => {
            const draft = drafts[a.id] ?? a.deletePermissions
            const changed = !same(draft, a.deletePermissions)
            const anyGranted = GRANTABLE_DELETE_PERMISSIONS.some((p) => a.deletePermissions[p])
            return (
              <li key={a.id} className={`rounded-lg border bg-white ${changed ? 'border-accent-line ring-1 ring-accent-line' : 'border-line'}`}>
                <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
                  <UserAvatar name={a.name} muted={!a.isActive} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-ink truncate">{a.name}</div>
                    <div className="text-[11.5px] text-ink-muted truncate">
                      <span className="font-mono">{a.employeeId}</span>
                      {a.designation ? ` · ${a.designation}` : ''}
                    </div>
                  </div>
                  {!a.isActive && <StatusBadge status="DISABLED" size="sm" />}
                </div>
                <div className="px-3 space-y-1.5">
                  {GRANTABLE_DELETE_PERMISSIONS.map((p) => (
                    <div key={p} className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md bg-subtle">
                      <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink-secondary">
                        <span className="text-ink-muted" aria-hidden>
                          {ICON[p]}
                        </span>
                        {DELETE_PERMISSION_LABEL[p]}
                      </span>
                      <Switch on={draft[p]} onClick={() => toggle(a.id, p)} label={`${DELETE_PERMISSION_LABEL[p]} for ${a.name}`} />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-2.5 mt-2 border-t border-line">
                  <span className="text-[11.5px] text-ink-muted">{changed ? 'Unsaved changes' : anyGranted ? 'Can delete permanently' : 'No delete access'}</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" disabled={!anyGranted || saving === a.id} onClick={() => save(a, none)}>
                      Revoke all
                    </Button>
                    <Button size="sm" variant="primary" disabled={!changed} loading={saving === a.id} onClick={() => save(a, draft)}>
                      Save
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** An on/off switch with its state as text too ("On" / "Off"), so it does not rely on colour. */
const Switch: React.FC<{ on: boolean; onClick: () => void; label: string }> = ({ on, onClick, label }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="inline-flex items-center gap-2 rounded-full">
    <span className={`w-8 text-right text-[11px] font-semibold uppercase tracking-wide ${on ? 'text-missed' : 'text-ink-muted'}`} aria-hidden>
      {on ? 'On' : 'Off'}
    </span>
    <span className={`relative w-8 h-[18px] rounded-full transition-colors ${on ? 'bg-[var(--color-failed)]' : 'bg-line-strong'}`} aria-hidden>
      <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-[var(--shadow-card)] transition-[left] ${on ? 'left-[16px]' : 'left-[2px]'}`} />
    </span>
  </button>
)
