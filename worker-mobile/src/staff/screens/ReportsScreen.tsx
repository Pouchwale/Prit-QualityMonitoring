import React, { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import type { QualityCheck } from '../types'
import { fileUrl } from '../../services/api'
import { downloadAndShare, shareText } from '../../services/files'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { FilterPanel, filterQuery, todayFilters, type MonitoringFilters } from '../Filters'
import { RESULT_LABEL, RESULT_OPTIONS, addDaysKey, checkStatusLabel, dateKey, formatDateTime, formatKey, plural, toCsv } from '../format'
import {
  Badge,
  DataState,
  List,
  ListFooterLink,
  MetricCard,
  MiniStat,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  Section,
  StatusBadge,
  useToast,
  type HeaderAction
} from '../ui'

const PRESETS = [
  { label: 'Today', range: () => ({ from: dateKey(), to: dateKey() }) },
  { label: 'Yesterday', range: () => ({ from: addDaysKey(dateKey(), -1), to: addDaysKey(dateKey(), -1) }) },
  { label: 'Last 7 Days', range: () => ({ from: addDaysKey(dateKey(), -6), to: dateKey() }) },
  { label: 'This Month', range: () => ({ from: `${dateKey().slice(0, 8)}01`, to: dateKey() }) }
]

/** How many rows each report section shows before "Show all". */
const TOP = 5

const workerOf = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'

interface Totals {
  scheduled: number
  completed: number
  missed: number
  exceptions: number
  open: number
}
const empty = (): Totals => ({ scheduled: 0, completed: 0, missed: 0, exceptions: 0, open: 0 })
function add(t: Totals, c: QualityCheck) {
  t.scheduled++
  if (c.result === 'COMPLETED') t.completed++
  else if (c.result === 'MISSED') t.missed++
  else if (c.result === 'EXCEPTION') t.exceptions++
  else t.open++
}

/** "Bearing temperature: Machine under maintenance" for every parameter the worker skipped. */
const naList = (c: QualityCheck) =>
  c.values
    .filter((v) => v.notApplicable)
    .map((v) => `${v.parameterName}: ${v.naReason ?? 'No reason'}${v.naRemark ? ` — ${v.naRemark}` : ''}`)
const completion = (t: Totals) => (t.scheduled ? Math.round((t.completed / t.scheduled) * 100) : 0)

function groupBy(checks: QualityCheck[], pick: (c: QualityCheck) => { key: string; name: string; detail: string | null }) {
  const map = new Map<string, Totals & { key: string; name: string; detail: string | null }>()
  for (const c of checks) {
    const { key, name, detail } = pick(c)
    const row = map.get(key) ?? { key, name, detail, ...empty() }
    add(row, c)
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const formatReading = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))

/** A list card that shows the first rows and a "Show all" / "Show less" toggle. */
function TopList<T>({ items, render, noun }: { items: T[]; render: (item: T) => React.ReactNode; noun: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, TOP)
  return (
    <List>
      {shown.map(render)}
      {items.length > TOP ? (
        <ListFooterLink
          label={all ? 'Show less' : `Show all ${items.length}`}
          accessibilityLabel={all ? `Show fewer ${noun}` : `Show all ${items.length} ${noun}`}
          icon={all ? 'chevron-up' : 'chevron-down'}
          onPress={() => setAll((v) => !v)}
        />
      ) : null}
    </List>
  )
}

/** A right-aligned figure in a report row; colour only when it means a status. */
const Figure: React.FC<{ value: string; tone?: 'neutral' | 'success' | 'missed' }> = ({ value, tone = 'neutral' }) => (
  <Text className={`text-[15px] font-semibold ${tone === 'success' ? 'text-success' : tone === 'missed' ? 'text-missed' : 'text-staff-ink2'}`}>{value}</Text>
)

/** Totals row: completed out of scheduled, with missed / exception counts. */
const groupDetail = (r: Totals & { detail: string | null }) =>
  [r.detail, r.missed ? `${r.missed} missed` : null, r.exceptions ? plural(r.exceptions, 'exception') : null].filter(Boolean).join(' · ') || null

/** Reports: the same summaries, CSV and PDF report as the web panel, for any period and filters. */
export const ReportsScreen: React.FC = () => {
  const { push } = useStaff()
  const notify = useToast()
  const [filters, setFilters] = useState<MonitoringFilters>(() => todayFilters())
  const [downloading, setDownloading] = useState(false)
  const { data, error, loading, reload } = useQuery<QualityCheck[]>('/api/quality-checks', { ...filterQuery(filters), result: filters.status })
  const checks = useMemo(() => data ?? [], [data])

  const totals = useMemo(() => {
    const t = empty()
    for (const c of checks) add(t, c)
    return t
  }, [checks])
  const byMachine = useMemo(() => groupBy(checks, (c) => ({ key: c.machineId, name: c.machineName, detail: c.machineCode })), [checks])
  const byWorker = useMemo(() => groupBy(checks, (c) => ({ key: c.submittedById ?? c.workerId ?? '—', name: workerOf(c), detail: c.submittedByEmployeeId ?? c.workerEmployeeId })), [checks])
  const parameters = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; unit: string | null; readings: number; within: number; outside: number; notApplicable: number; reasons: Map<string, number>; numbers: number[] }
    >()
    for (const c of checks) {
      if (c.result !== 'COMPLETED') continue
      for (const v of c.values) {
        const key = v.parameterId ?? v.parameterName
        const row =
          map.get(key) ?? { id: key, name: v.parameterName, unit: v.unit, readings: 0, within: 0, outside: 0, notApplicable: 0, reasons: new Map<string, number>(), numbers: [] }
        map.set(key, row)
        // Not-applicable parameters carry no reading, but their reasons belong in the report.
        if (v.notApplicable) {
          row.notApplicable++
          const reason = v.naReason ?? 'No reason'
          row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + 1)
          continue
        }
        if (v.value === null || v.value === '') continue
        row.readings++
        if (v.result === 'PASS') row.within++
        if (v.result === 'FAIL') row.outside++
        if (v.parameterType === 'NUMBER' && Number.isFinite(Number(v.value))) row.numbers.push(Number(v.value))
      }
    }
    return [...map.values()].filter((r) => r.readings || r.notApplicable).sort((a, b) => a.name.localeCompare(b.name))
  }, [checks])

  // Manual checks are started by the worker; notification checks come from the scheduler.
  const submissions = useMemo(() => {
    const done = checks.filter((c) => c.submittedAt)
    const manual = done.filter((c) => c.submissionType === 'MANUAL').length
    const naReadings = checks.reduce((sum, c) => sum + c.values.filter((v) => v.notApplicable).length, 0)
    const naChecks = checks.filter((c) => c.values.some((v) => v.notApplicable)).length
    return { submitted: done.length, manual, notification: done.length - manual, naReadings, naChecks }
  }, [checks])
  const nonConformances = checks.filter((c) => c.result === 'MISSED' || c.result === 'EXCEPTION')
  const period = filters.from === filters.to ? formatKey(filters.from) : `${formatKey(filters.from)} – ${formatKey(filters.to)}`

  const downloadPdf = async () => {
    setDownloading(true)
    try {
      await downloadAndShare(
        '/api/reports/quality-monitoring.pdf',
        `QMR-${filters.from.replace(/-/g, '')}-${filters.to.replace(/-/g, '')}.pdf`,
        { ...filterQuery(filters), result: filters.status },
        'application/pdf'
      )
      notify('success', 'Report ready', 'Save or share the PDF.')
    } catch (err) {
      notify('error', 'Could not generate the report', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  const exportCsv = async () => {
    const params: { name: string; unit: string | null }[] = []
    for (const c of checks) for (const v of c.values) if (!params.some((p) => p.name === v.parameterName)) params.push({ name: v.parameterName, unit: v.unit })
    const csv = toCsv(
      [
        'Check code', 'Scheduled at', 'Machine', 'Machine code', 'Department', 'Check type', 'Shift', 'Worker', 'Employee ID', 'Status', 'Result', 'Submission type', 'Item Code', 'Job No.',
        'Submitted at', 'Next check due', 'N/A parameters',
        'Parameters outside limits', ...params.map((p) => (p.unit ? `${p.name} (${p.unit})` : p.name)), 'Exception reason', 'Exception remark', 'Exception status', 'Photo URLs', 'Video URLs'
      ],
      checks.map((c) => [
        c.code, formatDateTime(c.scheduledAt), c.machineName, c.machineCode, c.departmentName, c.activityName, c.shiftName, workerOf(c), c.submittedByEmployeeId ?? c.workerEmployeeId,
        checkStatusLabel(c.status), c.result ? RESULT_LABEL[c.result] : '', c.submissionType === 'MANUAL' ? 'Manual' : 'Notification', c.itemCode ?? c.job?.itemCode ?? '', c.job?.jobNo ?? c.jobNo,
        c.submittedAt ? formatDateTime(c.submittedAt) : '', c.nextDueAt ? formatDateTime(c.nextDueAt) : '', naList(c).join('; '),
        c.values.filter((v) => v.result === 'FAIL').map((v) => `${v.parameterName}=${v.value ?? ''}${v.unit ? ` ${v.unit}` : ''}`).join('; '),
        ...params.map((p) => {
          const v = c.values.find((x) => x.parameterName === p.name)
          return v?.notApplicable ? `N/A (${v.naReason ?? 'no reason'})` : (v?.value ?? '')
        }),
        c.exception?.reason, c.exception?.remark, c.exception?.status,
        c.media.filter((m) => m.kind === 'PHOTO').map((m) => fileUrl(m.url)).join(' '),
        c.media.filter((m) => m.kind === 'VIDEO').map((m) => fileUrl(m.url)).join(' ')
      ])
    )
    try {
      await shareText(`quality-report_${filters.from}_${filters.to}.csv`, csv)
    } catch (err) {
      notify('error', 'Could not export', errorText(err))
    }
  }

  // Refresh stays a visible button because pull-to-refresh is not available in the web app.
  const actions: HeaderAction[] = [{ label: 'Refresh', icon: 'refresh-outline', onPress: reload }]
  if (checks.length) actions.push({ label: 'CSV', icon: 'download-outline', onPress: exportCsv })

  return (
    <Screen
      title="Reports"
      subtitle={period}
      right={actions}
      onRefresh={reload}
      refreshing={loading && !!data}
      footer={<PrimaryButton label="Download Report (PDF)" icon="document-text-outline" onPress={downloadPdf} loading={downloading} />}
    >
      <View className="-mt-2">
      <FilterPanel
        value={filters}
        onChange={setFilters}
        onReset={() => setFilters(todayFilters())}
        presets={PRESETS}
        fields={['status', 'machine', 'worker', 'activity', 'shift', 'department']}
        statusLabel="Result"
        statusOptions={RESULT_OPTIONS}
      />
      </View>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && checks.length === 0}
        emptyText="No quality records found for the selected date range."
        emptyIcon="bar-chart-outline"
      >
        <MetricCard
          label="Completion"
          value={completion(totals)}
          suffix="%"
          caption={`${totals.completed} of ${totals.scheduled} scheduled checks completed${totals.open ? ` · ${totals.open} still open` : ''}`}
          progress={completion(totals)}
        >
          <MiniStat label="Scheduled" value={totals.scheduled} tone="neutral" />
          <MiniStat label="Completed" value={totals.completed} tone="success" />
          <MiniStat label="Missed" value={totals.missed} tone="missed" />
          <MiniStat label="Exception" value={totals.exceptions} tone="exception" />
        </MetricCard>

        <Section title="How checks were submitted" detail="Manual checks are started by the worker; notification checks come from the schedule">
          <List>
            <Row
              title="Notification"
              subtitle={`${submissions.notification} of ${submissions.submitted} submitted`}
              right={<Figure value={`${submissions.submitted ? Math.round((submissions.notification / submissions.submitted) * 100) : 0}%`} />}
            />
            <Row
              title="Manual"
              subtitle={`${submissions.manual} of ${submissions.submitted} submitted`}
              right={<Figure value={`${submissions.submitted ? Math.round((submissions.manual / submissions.submitted) * 100) : 0}%`} />}
            />
            <Row
              title="Not applicable readings"
              subtitle={`${submissions.naReadings} in ${plural(submissions.naChecks, 'check')}`}
              detail="A not-applicable reading never counts as outside limits."
              detailLines={2}
              right={<Figure value={String(submissions.naReadings)} />}
            />
          </List>
        </Section>

        <Section title="By machine" detail={`${byMachine.length} machine${byMachine.length === 1 ? '' : 's'}`}>
          <TopList
            items={byMachine}
            noun="machines"
            render={(r) => (
              <Row
                key={r.key}
                title={r.name}
                subtitle={`${r.completed}/${r.scheduled} completed`}
                detail={groupDetail(r)}
                right={<Figure value={`${completion(r)}%`} tone={completion(r) === 100 ? 'success' : r.missed ? 'missed' : 'neutral'} />}
              />
            )}
          />
        </Section>

        <Section title="By worker" detail={`${byWorker.length} worker${byWorker.length === 1 ? '' : 's'}`}>
          <TopList
            items={byWorker}
            noun="workers"
            render={(r) => (
              <Row
                key={r.key}
                title={r.name}
                subtitle={`${r.completed}/${r.scheduled} completed`}
                detail={groupDetail(r)}
                right={<Figure value={`${completion(r)}%`} tone={completion(r) === 100 ? 'success' : r.missed ? 'missed' : 'neutral'} />}
              />
            )}
          />
        </Section>

        <Section title="Quality parameter readings" detail="Recorded in completed checks; readings outside limits do not change the Result">
          {parameters.length === 0 ? (
            <Notice title="No parameter readings in this period." />
          ) : (
            <TopList
              items={parameters}
              noun="parameters"
              render={(p) => {
                const has = p.numbers.length > 0
                const avg = has ? p.numbers.reduce((a, b) => a + b, 0) / p.numbers.length : 0
                const reasons = [...p.reasons.entries()].map(([reason, n]) => `${reason} ${n}`).join(' · ')
                return (
                  <Row
                    key={p.id}
                    title={`${p.name}${p.unit ? ` · ${p.unit}` : ''}`}
                    subtitle={`${p.readings} readings · ${p.within} within · ${p.outside} outside limits${p.notApplicable ? ` · ${p.notApplicable} not applicable` : ''}`}
                    detail={
                      [
                        has ? `Lowest ${formatReading(Math.min(...p.numbers))} · Highest ${formatReading(Math.max(...p.numbers))} · Average ${formatReading(avg)}` : null,
                        reasons ? `N/A: ${reasons}` : null
                      ]
                        .filter(Boolean)
                        .join('\n') || null
                    }
                    subtitleLines={2}
                    detailLines={3}
                    right={
                      p.outside ? (
                        <Badge label={`${p.outside} outside`} tone="missed" />
                      ) : p.notApplicable ? (
                        <Badge label={`${p.notApplicable} N/A`} tone="exception" />
                      ) : null
                    }
                  />
                )
              }}
            />
          )}
        </Section>

        <Section title="Missed and exception checks" detail={`${nonConformances.length} in ${period}`}>
          {nonConformances.length === 0 ? (
            <Notice tone="success" title="No missed or exception checks." />
          ) : (
            <TopList
              items={nonConformances}
              noun="missed and exception checks"
              render={(c) => (
                <Row
                  key={c.id}
                  title={c.machineName}
                  subtitle={`${c.activityName} · ${formatDateTime(c.scheduledAt)} · ${workerOf(c)}`}
                  detail={c.result === 'EXCEPTION' ? [c.exception?.reason, c.exception?.remark].filter(Boolean).join(' — ') || 'Exception' : `Window closed ${formatDateTime(c.windowEndsAt)}`}
                  detailLines={2}
                  accessibilityLabel={`${c.machineName} · ${c.activityName}`}
                  right={c.result ? <StatusBadge status={c.result} /> : <Badge label="Open" />}
                  onPress={() => push('checkDetail', { id: c.id })}
                />
              )}
            />
          )}
        </Section>
      </DataState>
    </Screen>
  )
}
