import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, RotateCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReportEmailAlert } from '../../types'
import { api, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { NAV_PATH } from '../../lib/routes'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { useToast } from '../common/Toast'
import { DeliveryStatusPill } from '../../pages/admin/reports/DeliveryStatus'

/** How often the panel asks for new failures while it is open. */
const POLL_MS = 60_000

const ALERT_EMAIL_TEXT: Record<NonNullable<ReportEmailAlert['alertEmailStatus']>, string> = {
  SENT: 'Failure alert email sent',
  FAILED: 'The failure alert email could not be sent',
  NOT_CONFIGURED: 'No failure alert email is set (Reports → Report Sharing → Recipients)',
  SKIPPED: 'No second alert email: one for the same error was sent less than 6 hours ago'
}

/**
 * Super Admin only (mounted by App for that role; the API refuses everyone else): a popup for each
 * automated report email that failed and was not dismissed yet. It shows on opening the panel, also
 * for failures while nobody was signed in, because the failures are stored on the server.
 * Dismiss acknowledges one failure (it is not shown again; the record stays); closing the popup hides
 * the current ones until the panel is opened again.
 */
export const ReportEmailFailurePopup: React.FC = () => {
  const notify = useToast()
  const [alerts, setAlerts] = useState<ReportEmailAlert[]>([])
  /** Closed with ×: hidden until the next page load, not acknowledged. */
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState<'retry' | 'dismiss' | null>(null)

  const load = useCallback(async () => {
    try {
      setAlerts(await api.get<ReportEmailAlert[]>('/api/reports/sharing/alerts', { open: '1' }))
    } catch {
      // Not shown when the server cannot be reached; the next poll tries again.
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, POLL_MS)
    const onFocus = () => document.visibilityState === 'visible' && void load()
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [load])

  const shown = alerts.filter((a) => !hidden.has(a.id))
  const alert = shown[0]
  if (!alert) return null
  const failedTo = alert.failedRecipients.length ? alert.failedRecipients : alert.email.recipients

  const openDetails = async () => {
    setDetails((d) => !d)
    if (!alert.readAt) await api.post(`/api/reports/sharing/alerts/${alert.id}/read`).catch(() => {})
  }
  const dismiss = async () => {
    setBusy('dismiss')
    try {
      await api.post(`/api/reports/sharing/alerts/${alert.id}/dismiss`)
      setDetails(false)
      setAlerts((list) => list.filter((a) => a.id !== alert.id))
    } catch (err) {
      notify('error', 'Could not dismiss the alert', errorText(err))
    } finally {
      setBusy(null)
    }
  }
  const retry = async () => {
    setBusy('retry')
    try {
      const result = await api.post<{ status: string; sent: string[]; error: string | null }>(`/api/reports/sharing/logs/${alert.logId}/retry`)
      if (result.status === 'SENT') notify('success', 'Email sent', `The mail server accepted it for ${result.sent.join(', ')}.`)
      else notify('error', result.status === 'RETRYING' ? 'Still failing: retried again later' : 'Still failing', result.error ?? 'Unknown error')
      await load()
    } catch (err) {
      notify('error', 'Could not retry', errorText(err))
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      isOpen
      // Later: every failure shown now is hidden until the panel is opened again; a new failure still pops up.
      onClose={() => setHidden((h) => new Set([...h, ...shown.map((a) => a.id)]))}
      title="Automated Schedule Email Failed"
      subtitle={shown.length > 1 ? `1 of ${shown.length} unacknowledged failures` : 'Not yet acknowledged'}
      maxWidth="lg"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 w-full">
          <Button size="sm" variant="ghost" onClick={openDetails} icon={details ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}>
            View Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={retry}
            loading={busy === 'retry'}
            disabled={!alert.canRetry || busy !== null}
            icon={<RotateCw className="w-3.5 h-3.5" />}
            title={alert.canRetry ? 'Send the same email again to the recipients it failed for' : 'Only a Failed or Retrying email can be sent again'}
          >
            Retry Sending
          </Button>
          <Button size="sm" variant="primary" onClick={dismiss} loading={busy === 'dismiss'} disabled={busy !== null}>
            Dismiss
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex items-start gap-2.5 rounded-lg border border-missed-line bg-missed-bg px-3 py-2.5 text-missed">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <span className="font-medium">An automated report email was not accepted by the mail server.</span>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-ink-muted">Schedule</dt>
          <dd className="text-ink font-medium">{alert.scheduleName}</dd>
          <dt className="text-ink-muted">Recipient</dt>
          <dd className="text-ink break-all">{failedTo.join(', ')}</dd>
          <dt className="text-ink-muted">Failed At</dt>
          <dd className="text-ink tabular-nums">{formatDateTime(alert.failedAt)}</dd>
          <dt className="text-ink-muted">Reason</dt>
          <dd className="text-missed break-words">{alert.errorMessage ?? 'Unknown error'}</dd>
          <dt className="text-ink-muted">Status now</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <DeliveryStatusPill status={alert.email.status} />
            <span className="text-[12px] text-ink-secondary">{alert.email.retryStatus}</span>
          </dd>
        </dl>

        {details && (
          <div className="rounded-lg border border-line bg-panel p-3 space-y-2.5" aria-label="Failure details">
            <div>
              <div className="text-[11.5px] text-ink-muted">Email</div>
              <div className="text-ink">{alert.email.subject}</div>
              <div className="text-[11.5px] text-ink-muted mt-0.5">
                Log ID <span className="font-mono">{alert.logId}</span> · {alert.email.attempts} attempt{alert.email.attempts === 1 ? '' : 's'}
                {alert.email.nextRetryAt ? ` · next retry ${formatDateTime(alert.email.nextRetryAt)}` : ''}
                {alert.email.recoveredAt ? ` · sent ${formatDateTime(alert.email.recoveredAt)}` : ''}
              </div>
            </div>
            <div>
              <div className="text-[11.5px] text-ink-muted mb-1">Each recipient</div>
              <ul className="space-y-1">
                {(alert.email.recipientStatus.length ? alert.email.recipientStatus : alert.email.recipients.map((email) => ({ email, status: alert.email.status, error: null }))).map((r) => (
                  <li key={r.email} className="flex flex-wrap items-start gap-2">
                    <DeliveryStatusPill status={r.status} />
                    <span className="text-ink break-all">{r.email}</span>
                    {r.error && <span className="basis-full text-[11.5px] text-missed break-words">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="text-[12px]">
              <span className="text-ink-muted">Alert email: </span>
              <span className={alert.alertEmailStatus === 'SENT' ? 'text-success' : 'text-missed'}>
                {alert.alertEmailStatus ? ALERT_EMAIL_TEXT[alert.alertEmailStatus] : 'Not sent yet'}
                {alert.alertEmailTo && alert.alertEmailStatus !== 'NOT_CONFIGURED' ? ` (${alert.alertEmailTo})` : ''}
              </span>
              {alert.alertEmailError && alert.alertEmailStatus === 'FAILED' && <div className="text-[11.5px] text-missed break-words">{alert.alertEmailError}</div>}
            </div>
            <Link
              to={`${NAV_PATH.reports}?tab=sharing`}
              onClick={() => setHidden((h) => new Set(h).add(alert.id))}
              className="inline-block text-[12px] font-medium text-accent-strong hover:underline"
            >
              Open the Delivery log
            </Link>
          </div>
        )}
      </div>
    </Modal>
  )
}
