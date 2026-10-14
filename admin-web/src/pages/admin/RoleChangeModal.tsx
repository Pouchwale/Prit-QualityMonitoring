import React, { useState } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import type { Role, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { ROLE_LABEL } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { FormError } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { useToast } from '../../components/common/Toast'
import { RoleBadge } from '../../components/ui/Chips'

const ROLES: Role[] = ['WORKER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN']
const RANK: Record<Role, number> = { WORKER: 0, MANAGER: 1, ADMIN: 2, SUPER_ADMIN: 3 }

const ROLE_SUMMARY: Record<Role, string> = {
  WORKER: 'Worker app only: quality checks on their shift. No admin panel.',
  MANAGER: 'Admin panel with the Manager role’s permissions (Roles & Permissions).',
  ADMIN: 'Admin panel with the Admin role’s permissions (Roles & Permissions).',
  SUPER_ADMIN: 'Everything, including roles, permissions and passwords.'
}

/**
 * Super Admin only: promotes or demotes an account in one step (PUT /api/users/:id/role). The
 * account, its history and its password stay; the user is signed out so their next sign-in uses the
 * new role, and permissions set for them alone are removed. The server refuses everyone else, a
 * change of one's own role, and demoting the last active Super Admin. Give it `key={user.id}` so each
 * account starts with no choice made.
 */
export const RoleChangeModal: React.FC<{ user: User | null; onClose: () => void; onChanged: () => void }> = ({ user, onClose, onChanged }) => {
  const notify = useToast()
  const [role, setRole] = useState<Role | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null
  const promote = role ? RANK[role] > RANK[user.role] : false

  const save = async () => {
    if (!role || role === user.role) return
    setSaving(true)
    setError(null)
    try {
      await api.put(`/api/users/${user.id}/role`, { role })
      notify('success', `${user.name} is now ${role === 'ADMIN' ? 'an' : 'a'} ${ROLE_LABEL[role]}`, 'They have been signed out; the change is in the audit log.')
      onChanged()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Change role"
      subtitle={`${user.name} · ${user.employeeId}`}
      maxWidth="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" variant={role && !promote ? 'danger' : 'primary'} onClick={save} disabled={!role || role === user.role} loading={saving}>
            {role ? `${promote ? 'Promote' : 'Demote'} to ${ROLE_LABEL[role]}` : 'Choose a role'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={error} />
        <div role="radiogroup" aria-label="New role" className="grid grid-cols-1 gap-2">
          {ROLES.map((r) => {
            const current = r === user.role
            const on = r === role
            return (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={current || saving}
                onClick={() => setRole(r)}
                className={`text-left rounded-lg border px-3 py-2.5 transition-colors disabled:cursor-default ${
                  on ? 'border-accent-line bg-accent-soft/50 ring-1 ring-accent-line' : current ? 'border-line bg-subtle' : 'border-line bg-white hover:bg-subtle'
                }`}
              >
                <div className="flex items-center gap-2">
                  <RoleBadge role={r} />
                  {current && <span className="text-[11.5px] text-ink-muted">Current role</span>}
                </div>
                <p className="mt-1 text-[12px] text-ink-secondary">{ROLE_SUMMARY[r]}</p>
              </button>
            )
          })}
        </div>

        {role && role !== user.role && (
          <div className="rounded-lg border border-line bg-panel p-3 space-y-1.5 text-[12.5px] text-ink-secondary" aria-live="polite">
            <div className="flex items-center gap-2 font-medium text-ink">
              <RoleBadge role={user.role} />
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />
              <RoleBadge role={role} />
            </div>
            <div className="flex gap-2">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-ink-muted" aria-hidden />
              <span>
                The account, its check history and its password stay. {user.name} is signed out on every device and gets the new role at the next
                sign-in. Permissions set for {user.name} alone are removed.
                {user.role === 'WORKER' ? ' Their shift sign-in ends now and they no longer get check alerts as a worker.' : ''}
                {role === 'WORKER' ? ' As a Worker they can use the worker app only.' : ''}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
