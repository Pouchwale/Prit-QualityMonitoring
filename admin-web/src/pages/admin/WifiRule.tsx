import React, { useEffect, useState } from 'react'
import { Save, Wifi } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCan } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader } from '../../components/ui/Card'

/** GET/PUT /api/shifts/wifi-rule (backend services/wifiRule.ts). */
interface WifiRuleSettings {
  enabled: boolean
  freshMinutes: number
  probeMinutes: number
}

/**
 * Shifts page: the Company Wi-Fi alert rule. Shown with Company Wi-Fi view, changed with Company Wi-Fi
 * edit (Roles & Permissions; the backend enforces the same).
 */
export const WifiRuleCard: React.FC = () => {
  const notify = useToast()
  const canEdit = useCan('wifi_rule', 'edit')
  const { data, error, loading, reload } = useApi<WifiRuleSettings>('/api/shifts/wifi-rule')
  const [form, setForm] = useState({ enabled: false, freshMinutes: '10', probeMinutes: '4' })
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data) setForm({ enabled: data.enabled, freshMinutes: String(data.freshMinutes), probeMinutes: String(data.probeMinutes) })
  }, [data])

  const dirty =
    !!data && (form.enabled !== data.enabled || form.freshMinutes !== String(data.freshMinutes) || form.probeMinutes !== String(data.probeMinutes))

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const fresh = Number(form.freshMinutes)
    const probe = Number(form.probeMinutes)
    if (!Number.isInteger(fresh) || fresh < 3 || fresh > 60) return setFormError('"Seen within" must be a whole number of minutes from 3 to 60.')
    if (!Number.isInteger(probe) || probe < 2 || probe > 30) return setFormError('"Ask phones every" must be a whole number of minutes from 2 to 30.')
    if (probe >= fresh) return setFormError('Ask phones more often than the "seen within" time, or phones drop out between checks.')
    setSaving(true)
    setFormError(null)
    try {
      await api.put('/api/shifts/wifi-rule', { enabled: form.enabled, freshMinutes: fresh, probeMinutes: probe })
      notify('success', 'Company Wi-Fi rule saved', form.enabled ? 'Check alerts now need company Wi-Fi and an active shift.' : 'Check alerts are sent as before.')
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Wifi className="w-4 h-4" />}
        title="Company Wi-Fi rule"
        subtitle={data ? (data.enabled ? 'On: check alerts only on company Wi-Fi, during the shift' : 'Off: check alerts are sent as before') : 'Check alerts only on company Wi-Fi'}
        info="When on, a check alert goes to a worker only while their shift is running and their phone is on company Wi-Fi. The plant server can only be reached on the company network, so a phone counts as on company Wi-Fi when it reached the server within the 'seen within' time: the open app reports every 2 minutes, and with the app closed the server asks the phone silently (Android app 1.2.0+). A phone that cannot be verified gets no check alert: the alert waits and goes out when the phone is seen again while the check is open. Shift sign-in reminders are not affected."
        actions={
          canEdit && data ? (
            <Button size="sm" variant="primary" type="submit" form="wifi-rule-form" loading={saving} disabled={!dirty} icon={<Save className="w-3.5 h-3.5" />}>
              Save
            </Button>
          ) : undefined
        }
      />
      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        <form id="wifi-rule-form" onSubmit={save} noValidate className="p-4 space-y-4">
          <FormError message={formError} />
          <Toggle
            checked={form.enabled}
            onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            disabled={!canEdit}
            label="Send check alerts only on company Wi-Fi, during the shift"
            description={canEdit ? 'Off: alerts are sent as before.' : 'You can view this rule; changing it needs the Company Wi-Fi edit permission.'}
          />
          {form.enabled && (
            <p className="rounded-md border border-exception-line bg-exception-bg px-3 py-2 text-[12px] text-exception">
              A phone that cannot be verified gets no check alert: switched off, battery saver, an app older than 1.2.0, the iPhone or browser app with
              the app closed. Watch the Company Wi-Fi column on the Workers page after turning this on.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Seen within (minutes)" hint="A phone counts as on company Wi-Fi this long after it last reached the server.">
              <TextInput type="number" min={3} max={60} value={form.freshMinutes} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, freshMinutes: e.target.value }))} />
            </Field>
            <Field label="Ask phones every (minutes)" hint="A phone not seen lately is asked silently this often during the shift.">
              <TextInput type="number" min={2} max={30} value={form.probeMinutes} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, probeMinutes: e.target.value }))} />
            </Field>
          </div>
        </form>
      </DataState>
    </Card>
  )
}

/** "Seen 3 min ago" / "Seen 12/10 4:05 PM" / "Not seen": the Workers page's Company Wi-Fi column. */
export const WifiSeen: React.FC<{ at: string | null; freshMinutes?: number }> = ({ at, freshMinutes = 10 }) => {
  if (!at) return <span className="text-ink-muted">Not seen</span>
  const minutes = Math.floor((Date.now() - new Date(at).getTime()) / 60_000)
  const fresh = minutes < freshMinutes
  const when = minutes < 60 ? `${Math.max(0, minutes)} min ago` : new Date(at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit' })
  return (
    <span className={`inline-flex items-center gap-1.5 ${fresh ? 'text-success font-medium' : 'text-ink-muted'}`} title={fresh ? 'On company Wi-Fi' : 'Not seen on company Wi-Fi lately'}>
      <Wifi className="w-3.5 h-3.5" aria-hidden />
      {fresh ? 'On Wi-Fi' : 'Seen'} · {when}
    </span>
  )
}
