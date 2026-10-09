import React, { useEffect, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Eye,
  FileText,
  History,
  Image as ImageIcon,
  Inbox,
  Lock,
  Mail,
  Percent,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  Shuffle,
  Users,
  Video,
  X,
  XCircle
} from 'lucide-react'
import type { ReportEmailLog, ReportSharingSettings, SamplePreviewResult } from '../../../types'
import { api, errorText, fetchBlob } from '../../../lib/api'
import { useAuth, useCanManage } from '../../../lib/auth'
import { useToast } from '../../../components/common/Toast'
import { Button } from '../../../components/common/Button'
import { Field, Select, TextInput, Toggle, inputClass } from '../../../components/common/Form'
import { Card, CardHeader, EmptyState } from '../../../components/ui/Card'
import { IconButton } from '../../../components/ui/Toolbar'
import { addDaysKey, dateKey, formatDateTime, fromPlantInput } from '../../../lib/format'

const FREQUENCY_OPTIONS = [
  { value: '60', label: 'Every 1 hour' },
  { value: '120', label: 'Every 2 hours' },
  { value: '240', label: 'Every 4 hours' },
  { value: '480', label: 'Every 8 hours' },
  { value: '720', label: 'Every 12 hours' },
  { value: '1440', label: 'Daily (every 24 hours)' },
  { value: 'custom_interval', label: 'Custom interval (hours / minutes)' },
  { value: 'daily_at', label: 'Daily at a specific time' }
]

const PERCENTAGE_PRESETS = [10, 20, 30, 50, 100]

/** Most checks the PDF preview takes at once; the server refuses more. */
const MAX_PREVIEW_CHECKS = 200

/** A datetime-local value (the plant's wall-clock time) as the ISO instant the API expects. */
const toIso = (value: string) => fromPlantInput(value).toISOString()

export const ReportSharingSection: React.FC = () => {
  const notify = useToast()
  // Saving the schedule, SMTP and sending need Reports manage (in practice Admin / Super Admin);
  // the PDF preview needs Export Reports as well. The server checks both again.
  const canManage = useCanManage('reports')
  const canExport = useAuth().can('export')

  // State: Settings
  const [settings, setSettings] = useState<ReportSharingSettings | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [testingSmtp, setTestingSmtp] = useState(false)
  const [smtpOpen, setSmtpOpen] = useState(false)

  // Settings form fields
  const [isEnabled, setIsEnabled] = useState(false)
  const [frequencyHours, setFrequencyHours] = useState(1)
  const [frequencySelection, setFrequencySelection] = useState<string>('60')
  const [frequencyMode, setFrequencyMode] = useState<'INTERVAL' | 'DAILY_AT'>('INTERVAL')
  const [frequencyMinutes, setFrequencyMinutes] = useState<number>(60)
  const [customIntervalValue, setCustomIntervalValue] = useState<number>(3)
  const [customIntervalUnit, setCustomIntervalUnit] = useState<'hours' | 'minutes'>('hours')
  const [scheduledTime, setScheduledTime] = useState<string>('18:00')

  const [percentage, setPercentage] = useState(20)
  const [recipientInput, setRecipientInput] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [smtpFrom, setSmtpFrom] = useState('')

  // State: Manual Send. The period fields hold the plant's wall-clock time (YYYY-MM-DDTHH:mm).
  const [manualFrom, setManualFrom] = useState<string>(() => `${dateKey()}T00:00`)
  const [manualTo, setManualTo] = useState<string>(() => `${dateKey()}T23:59`)
  const [manualPercentage, setManualPercentage] = useState(20)
  const [manualRecipients, setManualRecipients] = useState<string[]>([])
  const [manualRecipientInput, setManualRecipientInput] = useState('')
  const [previewSample, setPreviewSample] = useState<SamplePreviewResult | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [sendingManual, setSendingManual] = useState(false)

  // Quick periods are whole plant days, counted back from the plant's today.
  const setQuickPeriod = (preset: 'today' | 'yesterday' | '7days' | '30days') => {
    const today = dateKey()
    const back = { today: 0, yesterday: 1, '7days': 7, '30days': 30 }[preset]
    setManualFrom(`${addDaysKey(today, -back)}T00:00`)
    setManualTo(`${preset === 'yesterday' ? addDaysKey(today, -1) : today}T23:59`)
    // A sample taken for another period must never be sent.
    setPreviewSample(null)
  }

  // State: Audit Logs
  const [logs, setLogs] = useState<ReportEmailLog[]>([])
  const [loadingLogs, setLoadingLogs] = useState(true)

  const handleFrequencySelectionChange = (val: string) => {
    setFrequencySelection(val)
    if (val === 'daily_at') {
      setFrequencyMode('DAILY_AT')
    } else if (val === 'custom_interval') {
      setFrequencyMode('INTERVAL')
      const mins = customIntervalUnit === 'hours' ? customIntervalValue * 60 : customIntervalValue
      setFrequencyMinutes(mins)
      setFrequencyHours(Math.max(1, Math.round(mins / 60)))
    } else {
      setFrequencyMode('INTERVAL')
      const mins = Number(val)
      setFrequencyMinutes(mins)
      setFrequencyHours(Math.max(1, Math.round(mins / 60)))
    }
  }

  // Load Settings
  const loadSettings = async () => {
    try {
      setLoadingSettings(true)
      const data = await api.get<ReportSharingSettings>('/api/reports/sharing/settings')
      setSettings(data)
      setIsEnabled(data.isEnabled)
      setPercentage(data.percentage)
      setRecipients(data.recipients || [])
      setSmtpHost(data.smtpHost || '')
      setSmtpPort(data.smtpPort || 587)
      setSmtpSecure(data.smtpSecure || false)
      setSmtpUser(data.smtpUser || '')
      setSmtpPass(data.smtpPass || '')
      setSmtpFrom(data.smtpFrom || '')
      if (manualRecipients.length === 0 && data.recipients?.length) {
        setManualRecipients(data.recipients)
      }

      if (data.frequencyMode === 'DAILY_AT') {
        setFrequencyMode('DAILY_AT')
        setFrequencySelection('daily_at')
        setScheduledTime(data.scheduledTime || '18:00')
      } else {
        setFrequencyMode('INTERVAL')
        const mins = data.frequencyMinutes || (data.frequencyHours ? data.frequencyHours * 60 : 60)
        setFrequencyMinutes(mins)
        setFrequencyHours(Math.max(1, Math.round(mins / 60)))
        if ([60, 120, 240, 480, 720, 1440].includes(mins)) {
          setFrequencySelection(String(mins))
        } else {
          setFrequencySelection('custom_interval')
          if (mins % 60 === 0) {
            setCustomIntervalValue(mins / 60)
            setCustomIntervalUnit('hours')
          } else {
            setCustomIntervalValue(mins)
            setCustomIntervalUnit('minutes')
          }
        }
      }
    } catch {
      notify('error', 'Error', 'Failed to load report sharing settings.')
    } finally {
      setLoadingSettings(false)
    }
  }

  // Load Audit Logs
  const loadLogs = async () => {
    try {
      setLoadingLogs(true)
      const data = await api.get<ReportEmailLog[]>('/api/reports/sharing/logs')
      setLogs(data)
    } catch {
      // Best effort
    } finally {
      setLoadingLogs(false)
    }
  }

  useEffect(() => {
    loadSettings()
    loadLogs()
  }, [])

  // Save Settings
  const handleSaveSettings = async () => {
    try {
      setSavingSettings(true)
      const finalMinutes =
        frequencyMode === 'DAILY_AT'
          ? 1440
          : frequencySelection === 'custom_interval'
            ? customIntervalUnit === 'hours'
              ? customIntervalValue * 60
              : customIntervalValue
            : Number(frequencySelection)

      const payload: Partial<ReportSharingSettings> = {
        isEnabled,
        frequencyMode,
        frequencyMinutes: finalMinutes,
        frequencyHours: Math.max(1, Math.round(finalMinutes / 60)),
        scheduledTime: frequencyMode === 'DAILY_AT' ? scheduledTime : null,
        percentage,
        recipients,
        smtpHost: smtpHost.trim() || null,
        smtpPort: Number(smtpPort) || 587,
        smtpSecure,
        smtpUser: smtpUser.trim() || null,
        smtpPass: smtpPass || null,
        smtpFrom: smtpFrom.trim() || null
      }
      const updated = await api.put<ReportSharingSettings>('/api/reports/sharing/settings', payload)
      setSettings(updated)
      notify('success', 'Settings Saved', 'Automated report email settings saved successfully.')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings.'
      notify('error', 'Error', msg)
    } finally {
      setSavingSettings(false)
    }
  }

  // Test SMTP
  const handleTestSmtp = async () => {
    try {
      setTestingSmtp(true)
      const res = await api.post<{ ok: boolean; message: string }>('/api/reports/sharing/test-smtp', {
        smtpHost: smtpHost.trim() || null,
        smtpPort: Number(smtpPort) || 587,
        smtpSecure,
        smtpUser: smtpUser.trim() || null,
        smtpPass: smtpPass || null,
        smtpFrom: smtpFrom.trim() || null
      })
      if (res.ok) {
        notify('success', 'SMTP Connected', 'SMTP connection verified successfully!')
      } else {
        notify('error', 'SMTP Error', res.message || 'SMTP connection failed.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'SMTP test failed.'
      notify('error', 'SMTP Error', msg)
    } finally {
      setTestingSmtp(false)
    }
  }

  // Add recipient to automated list
  const addRecipient = () => {
    const email = recipientInput.trim().toLowerCase()
    if (!email) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notify('error', 'Invalid Email', 'Please enter a valid email address.')
      return
    }
    if (recipients.includes(email)) {
      notify('error', 'Duplicate Email', 'Recipient is already in the list.')
      return
    }
    setRecipients([...recipients, email])
    setRecipientInput('')
  }

  const removeRecipient = (index: number) => {
    setRecipients(recipients.filter((_, i) => i !== index))
  }

  // Add recipient to manual send list
  const addManualRecipient = () => {
    const email = manualRecipientInput.trim().toLowerCase()
    if (!email) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notify('error', 'Invalid Email', 'Please enter a valid email address.')
      return
    }
    if (manualRecipients.includes(email)) return
    setManualRecipients([...manualRecipients, email])
    setManualRecipientInput('')
  }

  const removeManualRecipient = (index: number) => {
    setManualRecipients(manualRecipients.filter((_, i) => i !== index))
  }

  // Generate / Refresh Sample Preview
  const handlePreviewSample = async () => {
    try {
      setLoadingPreview(true)
      const res = await api.post<SamplePreviewResult>('/api/reports/sharing/sample-preview', {
        periodFrom: toIso(manualFrom),
        periodTo: toIso(manualTo),
        percentage: manualPercentage
      })
      setPreviewSample(res)
      if (res.sampleCount === 0) {
        notify('info', 'No Checks Found', 'No eligible completed checks found in the selected period.')
      }
    } catch {
      notify('error', 'Error', 'Failed to preview sample checks.')
    } finally {
      setLoadingPreview(false)
    }
  }

  // Trigger Manual Send Now
  const handleSendManual = async () => {
    if (!manualRecipients.length) {
      notify('error', 'Missing Recipient', 'Please specify at least one recipient email address.')
      return
    }

    // Verify SMTP is configured before attempting send
    if (!smtpUser.trim() && !settings?.smtpUser) {
      notify(
        'error',
        'SMTP Not Configured',
        'Please enter SMTP Host, Username and Password under "SMTP Server Settings" and save them before sending.'
      )
      setSmtpOpen(true)
      return
    }

    try {
      setSendingManual(true)
      const res = await api.post<{
        success: boolean
        error?: string
        checksCount: number
        videoCount: number
        pdfSizeBytes: number
      }>('/api/reports/sharing/send-now', {
        recipients: manualRecipients,
        periodFrom: toIso(manualFrom),
        periodTo: toIso(manualTo),
        percentage: manualPercentage,
        customCheckIds: previewSample?.sampledCheckIds
      })

      if (res.success) {
        notify(
          'success',
          'Report Sent',
          `Crystal Reports document sent to ${manualRecipients.length} recipient(s) (${res.checksCount} checks, ${res.videoCount} videos).`
        )
        loadLogs()
      } else {
        notify('error', 'Send Failed', res.error || 'Failed to dispatch report email.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error sending report email.'
      notify('error', 'Send Failed', msg)
    } finally {
      setSendingManual(false)
    }
  }

  /*
   * Opens the PDF preview in a new tab. The PDF is fetched with the signed-in user's token in the
   * Authorization header (never in the link) and shown from a temporary blob URL. The tab is opened
   * straight away, while the click still counts, so the browser does not block it as a pop-up.
   */
  const handleOpenPdfPreview = async () => {
    if (!previewSample?.sampledCheckIds.length) {
      notify('error', 'Preview Unavailable', 'Generate a sample preview first to inspect the PDF.')
      return
    }
    const ids = previewSample.sampledCheckIds.slice(0, MAX_PREVIEW_CHECKS)
    if (ids.length < previewSample.sampledCheckIds.length) {
      notify('info', 'Preview Shortened', `The preview shows the first ${MAX_PREVIEW_CHECKS} sampled checks.`)
    }
    const tab = window.open('', '_blank')
    try {
      const blob = await fetchBlob(`/api/reports/sharing/preview-pdf?checkIds=${encodeURIComponent(ids.join(','))}`)
      const url = URL.createObjectURL(blob)
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
      // The tab has loaded the PDF by then; free the memory.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      tab?.close()
      notify('error', 'Preview Failed', errorText(err))
    }
  }

  const scheduleText =
    frequencyMode === 'DAILY_AT'
      ? `Daily at ${scheduledTime || '18:00'}`
      : frequencySelection === 'custom_interval'
        ? `Every ${customIntervalValue} ${customIntervalUnit}`
        : (FREQUENCY_OPTIONS.find((f) => f.value === frequencySelection)?.label ?? `Every ${frequencyHours}h`)

  return (
    <div className="space-y-5">
      {/* Summary: schedule, sampling and recipients at a glance */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <SummaryTile
          icon={<Clock className="w-4 h-4" />}
          label="Schedule"
          value={scheduleText}
          badge={<OnOffPill on={isEnabled} />}
          meta={isEnabled && settings?.nextRunAt ? `Next dispatch: ${formatDateTime(new Date(settings.nextRunAt))}` : 'Automated scheduler is currently paused'}
        />
        <SummaryTile
          icon={<Percent className="w-4 h-4" />}
          label="Sampling"
          value={`${percentage}% of eligible checks`}
          badge={<span className={`${pillBase} bg-accent-soft text-accent-strong ring-accent-line`}>{percentage}% random</span>}
          meta="Randomly sampled per cycle without duplicate bias"
        />
        <SummaryTile
          icon={<Mail className="w-4 h-4" />}
          label="Recipients"
          value={recipients.length ? `${recipients.length} configured` : 'None configured'}
          badge={
            <span className={`${pillBase} ${recipients.length ? 'bg-subtle text-ink-secondary ring-line' : 'bg-missed-bg text-missed ring-missed-line'}`}>
              {recipients.length} {recipients.length === 1 ? 'email' : 'emails'}
            </span>
          }
          meta={recipients.length ? recipients.join(', ') : 'Add recipients below to receive reports'}
        />
      </div>

      {loadingSettings && (
        <p className="flex items-center gap-2 text-[12px] text-ink-muted" role="status">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden />
          Loading settings…
        </p>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {/* Left: automated schedule, recipients and SMTP, saved together */}
        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader
              icon={<CalendarClock className="w-4 h-4" />}
              title="Automated schedule"
              subtitle="Recurring report emails"
              info="Automatically generate and email Crystal Reports-style quality reports on a recurring schedule. The inspection period is evaluated per cycle."
              actions={<OnOffPill on={isEnabled} />}
            />
            <div className="p-4 space-y-4">
              {/* Toggle Enable/Disable */}
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-subtle/60 px-3 py-2.5 cursor-pointer">
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-ink">Enable automated report dispatch</span>
                  <span className="block text-[11.5px] text-ink-muted">Send inspection reports automatically at the configured frequency</span>
                </span>
                <span className="relative inline-flex items-center shrink-0">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label="Enable automated report dispatch"
                    checked={isEnabled}
                    onChange={(e) => setIsEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <span
                    aria-hidden
                    className="w-10 h-[22px] rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:w-4 after:h-4 after:rounded-full after:bg-white after:shadow-[var(--shadow-card)] after:transition-transform peer-checked:after:translate-x-[18px]"
                  />
                </span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Frequency */}
                <div className="min-w-0">
                  <Field label="Email frequency" hint="Inspection period evaluated per cycle">
                    <Select aria-label="Email frequency" value={frequencySelection} onChange={(e) => handleFrequencySelectionChange(e.target.value)}>
                      {FREQUENCY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {/* Sub-inputs when Custom Interval is selected */}
                  {frequencySelection === 'custom_interval' && (
                    <div className="mt-2.5 p-2.5 rounded-lg border border-line bg-subtle/60 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="font-semibold text-ink-secondary">Custom interval</span>
                        <span className="font-semibold text-accent-strong">
                          Every {customIntervalValue} {customIntervalUnit}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          aria-label="Custom interval"
                          type="number"
                          min={1}
                          max={customIntervalUnit === 'hours' ? 168 : 10080}
                          value={customIntervalValue}
                          onChange={(e) => setCustomIntervalValue(Math.max(1, Number(e.target.value)))}
                          className={`${inputClass} w-20 text-center font-semibold`}
                        />
                        <Select
                          aria-label="Interval unit"
                          value={customIntervalUnit}
                          onChange={(e) => setCustomIntervalUnit(e.target.value as 'hours' | 'minutes')}
                          className="w-auto"
                        >
                          <option value="hours">Hours</option>
                          <option value="minutes">Minutes</option>
                        </Select>
                        <div className="flex flex-wrap gap-1" role="group" aria-label="Interval presets">
                          {(customIntervalUnit === 'hours' ? [3, 5, 6, 8, 36] : [15, 30, 45, 90]).map((n) => (
                            <Chip key={n} on={customIntervalValue === n} onClick={() => setCustomIntervalValue(n)}>
                              {n}
                              {customIntervalUnit === 'hours' ? 'h' : 'm'}
                            </Chip>
                          ))}
                        </div>
                      </div>
                      <p className="text-[11.5px] text-ink-muted">
                        Reports will automatically run and dispatch every {customIntervalValue} {customIntervalUnit}.
                      </p>
                    </div>
                  )}

                  {/* Sub-inputs when Daily at Specific Time is selected */}
                  {frequencySelection === 'daily_at' && (
                    <div className="mt-2.5 p-2.5 rounded-lg border border-line bg-subtle/60 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="font-semibold text-ink-secondary">Daily dispatch time</span>
                        <span className="font-semibold text-accent-strong">At {scheduledTime} daily</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          aria-label="Daily dispatch time"
                          type="time"
                          value={scheduledTime}
                          onChange={(e) => setScheduledTime(e.target.value)}
                          className={`${inputClass} w-28 font-semibold`}
                        />
                        <div className="flex flex-wrap gap-1" role="group" aria-label="Time presets">
                          {[
                            { time: '08:00', label: '8 AM' },
                            { time: '14:00', label: '2 PM' },
                            { time: '18:00', label: '6 PM' },
                            { time: '20:00', label: '8 PM' },
                            { time: '22:00', label: '10 PM' }
                          ].map((t) => (
                            <Chip key={t.time} on={scheduledTime === t.time} onClick={() => setScheduledTime(t.time)}>
                              {t.label}
                            </Chip>
                          ))}
                        </div>
                      </div>
                      <p className="text-[11.5px] text-ink-muted">Reports will be generated once per day at {scheduledTime} covering the completed day.</p>
                    </div>
                  )}
                </div>

                {/* Percentage */}
                <div className="min-w-0">
                  <span className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary mb-1.5">Check report percentage</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <input
                        aria-label="Check report percentage"
                        type="number"
                        min={1}
                        max={100}
                        value={percentage}
                        onChange={(e) => setPercentage(Math.min(100, Math.max(1, Number(e.target.value))))}
                        className={`${inputClass} w-20 text-center font-semibold`}
                      />
                      <span className="text-[12.5px] font-semibold text-ink-secondary">%</span>
                    </span>
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Percentage presets">
                      {PERCENTAGE_PRESETS.map((pct) => (
                        <Chip key={pct} on={percentage === pct} onClick={() => setPercentage(pct)}>
                          {pct}%
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-muted mt-1">e.g. 20% of 100 checks = 20 randomly sampled</p>
                </div>
              </div>
            </div>
          </Card>

          {/* Recipients List */}
          <Card>
            <CardHeader
              icon={<Users className="w-4 h-4" />}
              title="Recipients"
              subtitle="Who receives the automated reports"
              actions={<span className={`${pillBase} bg-subtle text-ink-secondary ring-line tabular-nums`}>{recipients.length}</span>}
            />
            <div className="p-4 space-y-2.5">
              <EmailAdder
                value={recipientInput}
                onChange={setRecipientInput}
                onAdd={addRecipient}
                label="Add email recipient"
                placeholder="Enter recipient email (e.g. quality@company.com)"
              />
              {recipients.length > 0 ? (
                <EmailChips emails={recipients} onRemove={removeRecipient} />
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-missed-line bg-missed-bg px-3 py-2 text-[12px] font-medium text-missed" role="status">
                  <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                  No recipients added. Automated reports will not be sent until at least one email is added.
                </div>
              )}
            </div>
          </Card>

          {/* SMTP Configuration Collapsible (manage only) */}
          {canManage && (
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setSmtpOpen(!smtpOpen)}
                aria-expanded={smtpOpen}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-subtle/60 transition-colors"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-7 h-7 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
                    <Server className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-ink leading-tight">SMTP server</span>
                    <span className="block text-[12px] text-ink-muted truncate">
                      {smtpHost ? `${smtpHost}:${smtpPort}${smtpUser ? ` · ${smtpUser}` : ''}` : 'Email dispatch settings · not set'}
                    </span>
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-strong shrink-0">
                  {smtpOpen ? 'Hide' : 'Configure'}
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${smtpOpen ? 'rotate-180' : ''}`} aria-hidden />
                </span>
              </button>

              {smtpOpen && (
                <div className="p-4 space-y-3 border-t border-line">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Field label="SMTP Host" className="sm:col-span-2">
                      <TextInput aria-label="SMTP host" placeholder="smtp.gmail.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                    </Field>
                    <Field label="Port">
                      <TextInput aria-label="SMTP port" type="number" placeholder="587" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Username / Email">
                      <TextInput aria-label="SMTP username" placeholder="alerts@company.com" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                    </Field>
                    <Field label="Password / App Password">
                      <TextInput
                        aria-label="SMTP password"
                        autoComplete="new-password"
                        type="password"
                        placeholder="••••••••"
                        value={smtpPass}
                        onChange={(e) => setSmtpPass(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                    <Field label="Sender 'From' address">
                      <TextInput
                        aria-label="Sender 'From' address"
                        placeholder="Quality Monitoring <quality@company.com>"
                        value={smtpFrom}
                        onChange={(e) => setSmtpFrom(e.target.value)}
                      />
                    </Field>
                    <div className="sm:pb-1.5">
                      <Toggle checked={smtpSecure} onChange={setSmtpSecure} label="Use SSL/TLS (Port 465)" />
                    </div>
                  </div>
                  <div className="pt-1 flex justify-end">
                    <Button size="sm" variant="outline" onClick={handleTestSmtp} loading={testingSmtp} icon={<Play className="w-3.5 h-3.5" />}>
                      Test SMTP connection
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Action Button: saves the schedule, recipients and SMTP settings above */}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {canManage ? (
              <>
                <span className="text-[11.5px] text-ink-muted">Saves schedule, recipients and SMTP</span>
                <Button size="sm" variant="primary" onClick={handleSaveSettings} loading={savingSettings} icon={<CheckCircle2 className="w-3.5 h-3.5" />}>
                  Save schedule settings
                </Button>
              </>
            ) : (
              <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Lock className="w-3.5 h-3.5" aria-hidden />
                Only an Admin can change the schedule and email settings.
              </p>
            )}
          </div>
        </div>

        {/* Right: Manual Send Report (Immediate Dispatch) */}
        <Card className="min-w-0">
          <CardHeader
            icon={<Send className="w-4 h-4" />}
            title="Manual send"
            subtitle="Send a report now, without waiting for the schedule"
            info="Generate and send Crystal Reports-style quality reports on demand without waiting for the schedule. Sample the checks first to preview them and the PDF."
          />
          <div className="p-4 space-y-4">
            {/* Date & Time Range */}
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Period from">
                  <input
                    aria-label="Period from"
                    type="datetime-local"
                    value={manualFrom}
                    onChange={(e) => {
                      setManualFrom(e.target.value)
                      setPreviewSample(null)
                    }}
                    className={inputClass}
                  />
                </Field>
                <Field label="Period to">
                  <input
                    aria-label="Period to"
                    type="datetime-local"
                    value={manualTo}
                    onChange={(e) => {
                      setManualTo(e.target.value)
                      setPreviewSample(null)
                    }}
                    className={inputClass}
                  />
                </Field>
              </div>
              {/* Quick Presets */}
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Quick periods">
                <span className="text-[11.5px] text-ink-muted font-medium mr-1">Quick select</span>
                <Chip onClick={() => setQuickPeriod('today')}>Today</Chip>
                <Chip onClick={() => setQuickPeriod('yesterday')}>Yesterday</Chip>
                <Chip onClick={() => setQuickPeriod('7days')}>Last 7 days</Chip>
                <Chip onClick={() => setQuickPeriod('30days')}>Last 30 days</Chip>
              </div>
            </div>

            {/* Sampling Percentage & Preview Trigger */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] lg:text-[12.5px] font-medium text-ink-secondary">Random sample percentage</span>
                <span className="text-[12.5px] font-semibold text-accent-strong tabular-nums">{manualPercentage}%</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  aria-label="Random sample percentage"
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  value={manualPercentage}
                  onChange={(e) => {
                    setManualPercentage(Number(e.target.value))
                    setPreviewSample(null)
                  }}
                  className="flex-1 min-w-0 accent-accent"
                />
                <Button size="sm" variant="outline" onClick={handlePreviewSample} loading={loadingPreview} icon={<Shuffle className="w-3.5 h-3.5" />}>
                  Sample checks
                </Button>
              </div>
            </div>

            {/* Sample Preview Card */}
            {previewSample && (
              <div className="rounded-lg border border-line bg-subtle/60 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold text-ink">
                    Sampled {previewSample.sampleCount} of {previewSample.eligibleTotal} eligible check(s) ({previewSample.percentage}%)
                  </span>
                  <span className="text-[11.5px] text-ink-muted">Randomly chosen</span>
                </div>

                {/* Sampled checks mini list */}
                {previewSample.checks.length > 0 ? (
                  <ul className="max-h-44 overflow-y-auto space-y-1 pr-1">
                    {previewSample.checks.map((chk) => (
                      <li key={chk.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px]">
                        <span className="min-w-0 truncate">
                          <span className="font-semibold text-ink font-mono text-[11.5px]">{chk.code}</span>
                          <span className="text-ink-muted"> · {chk.itemCode || chk.machineName} · {chk.workerName}</span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {chk.outsideLimitsCount > 0 ? (
                            <span className={`${pillBase} bg-missed-bg text-missed ring-missed-line`}>Defect</span>
                          ) : (
                            <span className={`${pillBase} bg-success-bg text-success ring-success-line`}>Pass</span>
                          )}
                          <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-muted tabular-nums" title={`${chk.photoCount} photos, ${chk.videoCount} videos`}>
                            <ImageIcon className="w-3 h-3" aria-hidden />
                            {chk.photoCount}
                            {chk.videoCount ? (
                              <>
                                <Video className="w-3 h-3 ml-1" aria-hidden />
                                {chk.videoCount}
                              </>
                            ) : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rounded-md border border-exception-line bg-exception-bg px-2.5 py-2 text-[12px] text-exception" role="status">
                    No checks found matching this date interval. Try expanding the date range.
                  </div>
                )}
              </div>
            )}

            {/* Manual Recipients */}
            <div className="space-y-2">
              <span className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary">Recipients for this send</span>
              <EmailAdder
                value={manualRecipientInput}
                onChange={setManualRecipientInput}
                onAdd={addManualRecipient}
                label="Add recipient for this send"
                placeholder="Enter email address"
              />
              {manualRecipients.length > 0 && <EmailChips emails={manualRecipients} onRemove={removeManualRecipient} />}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="px-4 py-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
            {canExport ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenPdfPreview}
                disabled={!previewSample?.checks.length}
                icon={<Eye className="w-3.5 h-3.5" />}
                title="Preview Crystal Reports PDF document"
              >
                Preview PDF
              </Button>
            ) : (
              <span />
            )}

            {canManage ? (
              <Button size="sm" variant="primary" onClick={handleSendManual} loading={sendingManual} disabled={!manualRecipients.length} icon={<Send className="w-3.5 h-3.5" />}>
                Send report now
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Lock className="w-3.5 h-3.5" aria-hidden />
                Only an Admin can send reports.
              </span>
            )}
          </div>
        </Card>
      </div>

      {/* Delivery Audit History & Logs */}
      <Card className="overflow-hidden">
        <CardHeader
          icon={<History className="w-4 h-4" />}
          title="Delivery log"
          subtitle={`${logs.length} report ${logs.length === 1 ? 'email' : 'emails'} sent`}
          info="Complete audit log of all automated and manual report email dispatches."
          actions={
            <IconButton label="Refresh logs" onClick={loadLogs} disabled={loadingLogs}>
              <RefreshCw className={`w-4 h-4 ${loadingLogs ? 'animate-spin' : ''}`} />
            </IconButton>
          }
        />
        {logs.length > 0 ? (
          <div className="overflow-x-auto lg:max-h-[480px] lg:overflow-y-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Recipients</th>
                  <th className="num">Checks</th>
                  <th>Attachments</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const isSuccess = log.status === 'SUCCESS'
                  const isAuto = log.trigger === 'AUTO'
                  return (
                    <tr key={log.id}>
                      <td className="whitespace-nowrap">
                        <div className="font-medium text-ink tabular-nums">{formatDateTime(new Date(log.sentAt))}</div>
                        <div className="text-[11.5px] text-ink-muted">{log.sentByName || (isAuto ? 'System Scheduler' : 'Admin')}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        <span
                          className={`${pillBase} gap-1 ${isSuccess ? 'bg-success-bg text-success ring-success-line' : 'bg-missed-bg text-missed ring-missed-line'}`}
                          title={!isSuccess && log.errorMessage ? log.errorMessage : undefined}
                        >
                          {isSuccess ? <CheckCircle2 className="w-3 h-3" aria-hidden /> : <XCircle className="w-3 h-3" aria-hidden />}
                          {isSuccess ? 'Sent' : 'Failed'}
                        </span>
                        {!isSuccess && log.errorMessage && (
                          <div className="mt-0.5 max-w-[220px] truncate text-[11.5px] text-missed" title={log.errorMessage}>
                            {log.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <span className={`${pillBase} gap-1 ${isAuto ? 'bg-subtle text-ink-secondary ring-line' : 'bg-accent-soft text-accent-strong ring-accent-line'}`}>
                          {isAuto ? <Clock className="w-3 h-3" aria-hidden /> : <Send className="w-3 h-3" aria-hidden />}
                          {isAuto ? 'Auto' : 'Manual'}
                        </span>
                      </td>
                      <td className="max-w-[280px]" title={log.recipients.join(', ')}>
                        <div className="truncate text-ink">{log.recipients[0] ?? '—'}</div>
                        {log.recipients.length > 1 && <div className="text-[11.5px] text-ink-muted">+{log.recipients.length - 1} more</div>}
                      </td>
                      <td className="num">
                        <div className="font-semibold text-ink">{log.checksCount}</div>
                        <div className="text-[11.5px] text-ink-muted">{log.percentage ? `${log.percentage}% sample` : '—'}</div>
                      </td>
                      <td className="whitespace-nowrap text-ink-secondary">
                        <span className="inline-flex items-center gap-1">
                          <FileText className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                          {log.pdfSizeBytes ? `${(log.pdfSizeBytes / (1024 * 1024)).toFixed(1)} MB PDF` : 'PDF'}
                        </span>
                        {log.videoCount > 0 && (
                          <span className="ml-2 inline-flex items-center gap-1 font-medium text-accent-strong">
                            <Video className="w-3.5 h-3.5" aria-hidden />+ {log.videoCount} Video{log.videoCount === 1 ? '' : 's'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            title="No report emails have been dispatched yet"
            hint="When reports are sent automatically or manually, their audit history will appear here."
          />
        )}
      </Card>
    </div>
  )
}

const pillBase = 'inline-flex items-center h-5 px-2 rounded-full ring-1 ring-inset text-[11px] font-semibold whitespace-nowrap'

const OnOffPill: React.FC<{ on: boolean }> = ({ on }) => (
  <span className={`${pillBase} gap-1.5 ${on ? 'bg-success-bg text-success ring-success-line' : 'bg-subtle text-ink-muted ring-line'}`}>
    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-[var(--color-chart-completed)]' : 'bg-ink-faint'}`} aria-hidden />
    {on ? 'Active' : 'Disabled'}
  </span>
)

/** One of the three figures at the top: icon, label, a short value, a badge and one muted line. */
const SummaryTile: React.FC<{ icon: React.ReactNode; label: string; value: string; badge: React.ReactNode; meta: string }> = ({ icon, label, value, badge, meta }) => (
  <div className="card p-3.5 min-w-0">
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 min-w-0">
        <span className="w-7 h-7 shrink-0 rounded-md bg-accent-soft text-accent flex items-center justify-center" aria-hidden>
          {icon}
        </span>
        <span className="text-[12.5px] font-medium text-ink-secondary truncate">{label}</span>
      </span>
      {badge}
    </div>
    <div className="mt-2.5 text-[16px] font-semibold text-ink leading-tight truncate" title={value}>
      {value}
    </div>
    <div className="mt-1 text-[12px] text-ink-muted truncate" title={meta}>
      {meta}
    </div>
  </div>
)

/** A small preset button; `on` marks the preset in use. */
const Chip: React.FC<{ on?: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={on === undefined ? undefined : on}
    className={`h-9 lg:h-6 px-2 rounded-md ring-1 ring-inset text-[11.5px] font-medium tabular-nums whitespace-nowrap transition-colors ${
      on ? 'bg-accent-soft text-accent-strong ring-accent-line' : 'bg-surface text-ink-secondary ring-line hover:bg-subtle hover:text-ink'
    }`}
  >
    {children}
  </button>
)

/** Email field with an Add button; Enter adds too. */
const EmailAdder: React.FC<{ value: string; onChange: (v: string) => void; onAdd: () => void; label: string; placeholder: string }> = ({
  value,
  onChange,
  onAdd,
  label,
  placeholder
}) => (
  <div className="flex gap-2">
    <input
      aria-label={label}
      type="email"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onAdd())}
      className={`${inputClass} flex-1`}
    />
    <Button size="field" variant="outline" onClick={onAdd} icon={<Plus className="w-3.5 h-3.5" />}>
      Add
    </Button>
  </div>
)

/** Added emails as removable chips. */
const EmailChips: React.FC<{ emails: string[]; onRemove: (index: number) => void }> = ({ emails, onRemove }) => (
  <ul className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
    {emails.map((email, idx) => (
      <li key={idx} className="inline-flex items-center gap-1 pl-2.5 pr-0.5 h-7 rounded-full text-[12px] bg-subtle ring-1 ring-inset ring-line text-ink max-w-full min-w-0">
        <Mail className="w-3 h-3 shrink-0 text-ink-muted" aria-hidden />
        <span className="min-w-0 truncate" title={email}>
          {email}
        </span>
        <button
          type="button"
          onClick={() => onRemove(idx)}
          className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full text-ink-muted hover:text-missed hover:bg-missed-bg transition-colors"
          aria-label={`Remove ${email}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </li>
    ))}
  </ul>
)
