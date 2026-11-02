import React, { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { downloadPost, errorText } from '../../lib/api'
import { Button } from '../../components/common/Button'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'

/**
 * Super Admin only: downloads a PDF of every account's employee ID and viewable password, after the
 * Super Admin confirms with their own password. The export is recorded in the audit log.
 */
export const ExportPasswordsModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setConfirmPassword('')
    setError(null)
  }, [isOpen])

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!confirmPassword) return
    setLoading(true)
    setError(null)
    try {
      await downloadPost('/api/users/passwords/export', { confirmPassword }, 'user-credentials.pdf')
      setConfirmPassword('')
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Download credentials PDF"
      subtitle="Employee ID and password of every account"
      maxWidth="sm"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" form="export-passwords-form" loading={loading} disabled={!confirmPassword}>
            Download PDF
          </Button>
        </>
      }
    >
      <form id="export-passwords-form" onSubmit={submit} className="space-y-3" autoComplete="off">
        <FormError message={error} />
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-subtle border border-line text-[13.5px] text-ink-secondary">
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent" aria-hidden />
          <span>Confirm it is you. This export is recorded in the audit log. Keep the file private and delete it after use.</span>
        </div>
        <Field label="Your password" required>
          <TextInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
      </form>
    </Modal>
  )
}
