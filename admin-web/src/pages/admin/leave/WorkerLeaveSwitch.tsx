import React, { useState } from 'react'
import { Lock, Smartphone } from 'lucide-react'
import { api, errorText } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { useAuth } from '../../../lib/auth'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { useToast } from '../../../components/common/Toast'
import { Card } from '../../../components/ui/Card'

/**
 * Leave for workers, on or off for every worker at once (the Worker role's "Leave in the app",
 * routes/leave.ts "worker-access"). Off: the Leave tab disappears from every worker's mobile app and
 * worker web app (open apps within 2 minutes) and the server refuses their leave requests. Only the
 * Super Admin switches it; others see the state.
 */
export const WorkerLeaveSwitch: React.FC = () => {
  const { isSuperAdmin } = useAuth()
  const notify = useToast()
  const state = useApi<{ enabled: boolean }>('/api/leave/worker-access')
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const enabled = state.data?.enabled ?? false

  const save = async (next: boolean) => {
    setBusy(true)
    try {
      await api.put('/api/leave/worker-access', { enabled: next })
      state.setData({ enabled: next })
      notify(
        'success',
        next ? 'Leave turned on for workers' : 'Leave turned off for workers',
        next ? 'Workers see the Leave tab in the app.' : 'The Leave tab is gone from every worker’s app.'
      )
    } catch (err) {
      notify('error', 'Could not change leave for workers', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (state.loading && !state.data) return null
  if (state.error) return null

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-start gap-3 min-w-0 flex-1 basis-64">
          <span
            className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${enabled ? 'bg-success-bg text-success' : 'bg-subtle text-ink-muted'}`}
            aria-hidden
          >
            <Smartphone className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Leave requests for workers</h2>
            <p className="mt-0.5 text-[13.5px] text-ink-muted leading-snug">
              {enabled
                ? 'On: workers apply for leave and shift changes in the mobile app and the worker web app.'
                : 'Off: the Leave tab is hidden from every worker on the mobile app and the worker web app, and leave requests are refused.'}
            </p>
            {!isSuperAdmin && (
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] text-ink-muted">
                <Lock className="w-3.5 h-3.5" aria-hidden />
                Only the Super Admin can change this.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Leave requests for workers"
          disabled={!isSuperAdmin || busy}
          onClick={() => (enabled ? setConfirmOff(true) : save(true))}
          className="group inline-flex items-center gap-2.5 h-10 pl-1 pr-3 rounded-full disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span
            className={`relative w-11 h-6 rounded-full ring-1 ring-inset transition-colors duration-200 ${
              enabled ? 'bg-accent-fill ring-accent-fill' : 'bg-subtle ring-line-strong'
            }`}
            aria-hidden
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.3)] transition-transform duration-200 ease-out ${
                enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </span>
          <span className={`text-[14px] font-semibold ${enabled ? 'text-success' : 'text-ink-muted'}`}>{enabled ? 'On' : 'Off'}</span>
        </button>
      </div>

      <ConfirmModal
        isOpen={confirmOff}
        title="Turn off leave for all workers?"
        message="The Leave tab disappears from every worker's mobile app and worker web app (apps already open within 2 minutes), and the server refuses new leave and shift change requests. Requests already made stay here for you to decide, and workers are not notified of those decisions while leave is off."
        confirmLabel="Turn off"
        danger
        onConfirm={() => save(false)}
        onClose={() => setConfirmOff(false)}
      />
    </Card>
  )
}
