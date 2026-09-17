import React, { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { Button } from '../../components/common/Button'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'

interface Props {
  user: { id: string; name: string; employeeId: string } | null
  onClose: () => void
}

/**
 * Super Admin only: shows a user's password after the Super Admin confirms with their own
 * password. Each view is recorded in the audit log. The password is cleared on close.
 */
export const RevealPasswordModal: React.FC<Props> = ({ user, onClose }) => {
  const [confirmPassword, setConfirmPassword] = useState('')
  const [result, setResult] = useState<{ available: boolean; password: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setConfirmPassword('')
    setResult(null)
    setError(null)
    setVisible(true)
    setCopied(false)
  }, [user])

  const reveal = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!user || !confirmPassword) return
    setLoading(true)
    setError(null)
    try {
      setResult(await api.post(`/api/users/${user.id}/password/reveal`, { confirmPassword }))
      setConfirmPassword('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!result?.password) return
    try {
      await navigator.clipboard.writeText(result.password)
      setCopied(true)
    } catch {
      setVisible(true)
    }
  }

  return (
    <Modal
      isOpen={user !== null}
      onClose={onClose}
      title="View password"
      subtitle={user ? `${user.name} (${user.employeeId})` : undefined}
      maxWidth="sm"
      footer={
        result ? (
          <Button size="sm" variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="reveal-password-form" loading={loading} disabled={!confirmPassword}>
              Show password
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <form id="reveal-password-form" onSubmit={reveal} className="space-y-3" autoComplete="off">
          <FormError message={error} />
          <Field label="Your password" required hint="Confirm it is you. This view is recorded in the audit log.">
            <TextInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="current-password" autoFocus />
          </Field>
        </form>
      ) : result.available && result.password !== null ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-700">Password</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 px-3 py-2 rounded border border-line-strong bg-subtle font-mono text-sm text-ink break-all" aria-live="polite">
              {visible ? result.password : '•'.repeat(Math.max(8, result.password.length))}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'Hide password' : 'Show password'}
              icon={visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            />
            <Button size="sm" variant="outline" onClick={copy} icon={<Copy className="w-3.5 h-3.5" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-[11px] text-ink-muted">Share it only with {user?.name}. It is hidden again when you close this.</p>
        </div>
      ) : (
        <div className="px-3 py-2.5 rounded border border-exception-line bg-exception-bg text-xs text-ink-secondary space-y-1">
          <div className="font-semibold text-exception">Not available</div>
          <p>
            This password was set before passwords could be viewed, so only its one-way fingerprint is stored. To see it, set a new password with
            Edit → New password; from then on it can be viewed here.
          </p>
        </div>
      )}
    </Modal>
  )
}
