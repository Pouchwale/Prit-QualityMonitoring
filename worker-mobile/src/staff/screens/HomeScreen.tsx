import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { CalendarYearSummary, DashboardData, ExceptionRecord, ModuleInfo, QualityCheck, User } from '../types'
import { useStaff } from '../nav'
import { useQuery } from '../useQuery'
import { ROLE_LABEL, addDaysKey, dateKey, formatKey, formatTime, plural } from '../format'
import {
  Badge,
  Card,
  DataState,
  DateField,
  Empty,
  Icon,
  LinkButton,
  List,
  ListFooterLink,
  MetricCard,
  MiniStat,
  Notice,
  Row,
  Screen,
  Section,
  SkeletonRows
} from '../ui'
import { formatLongDate } from '../../utils/datetime'

const REFRESH_MS = 60_000
const REPEAT_WINDOW_DAYS = 7
/** Warnings shown before "Show N more". */
const WARNINGS_SHOWN = 2
/** Rows per "Needs attention" list. */
const ATTENTION_ROWS = 3
const TOP_ROWS = 5
/** Machines with problems shown before "See all". */
const MACHINE_ROWS = 3

const workerOf = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? '—'

interface RepeatRow {
  key: string
  name: string
  detail: string | null
  total: number
}

function repeated(checks: QualityCheck[], pick: (c: QualityCheck) => { key: string; name: string; detail: string | null }) {
  const map = new Map<string, RepeatRow>()
  for (const c of checks) {
    const { key, name, detail } = pick(c)
    const row = map.get(key) ?? { key, name, detail, total: 0 }
    row.total++
    map.set(key, row)
  }
  return [...map.values()].filter((r) => r.total >= 2).sort((a, b) => b.total - a.total)
}

/**
 * Home: a role-based dashboard. Admins and the Super Admin see plant-wide progress plus setup
 * warnings; Managers see today's progress, their team and what awaits their review.
 * Each section only appears (and only loads) when the account has access to its data.
 */
export const HomeScreen: React.FC = () => {
  const { profile, can, isAdmin, push, switchTab } = useStaff()
  const [date, setDate] = useState(dateKey)
  const isToday = date === dateKey()
  const monitoring = can('dashboard') || can('checks') || can('exceptions')
  const canList = can('checks') || can('dashboard') || can('reports')
  // Same rule as StaffApp's tab bar.
  const checksTab = can('checks')
  const exceptionsTab = can('exceptions')

  const dashboard = useQuery<DashboardData>(monitoring ? '/api/dashboard' : null, { date })
  const missed = useQuery<QualityCheck[]>(canList ? '/api/quality-checks' : null, { from: addDaysKey(date, -(REPEAT_WINDOW_DAYS - 1)), to: date, status: 'MISSED' })
  const dayChecks = useQuery<QualityCheck[]>(canList && !isAdmin ? '/api/quality-checks' : null, { from: date, to: date })
  const exceptions = useQuery<ExceptionRecord[]>(can('exceptions') ? '/api/exceptions' : null, { from: addDaysKey(dateKey(), -29), to: dateKey() })
  const workers = useQuery<User[]>(isAdmin && can('assignments') ? '/api/users' : null, { role: 'WORKER' })
  const years = useQuery<{ years: CalendarYearSummary[] }>(isAdmin && can('calendar') ? '/api/calendar-years' : null)
  // Only needed for the welcome card of a Manager without monitoring access ("Your access" lives on My Account).
  const modules = useQuery<ModuleInfo[]>(!isAdmin && !monitoring && !canList ? '/api/access/modules' : null)

  const [showAllWarnings, setShowAllWarnings] = useState(false)
  const [showAllMachines, setShowAllMachines] = useState(false)
  const [showAllTeam, setShowAllTeam] = useState(false)
  const [showRepeats, setShowRepeats] = useState(false)

  const reloadDashboard = dashboard.reload
  const reloadMissed = missed.reload
  const reloadDay = dayChecks.reload
  const reloadExceptions = exceptions.reload
  const reloadWorkers = workers.reload
  const reloadYears = years.reload
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadDashboard(), reloadMissed(), reloadDay(), reloadExceptions(), reloadWorkers(), reloadYears()])
  }, [reloadDashboard, reloadMissed, reloadDay, reloadExceptions, reloadWorkers, reloadYears])

  // Monitoring data refreshes every minute, like the web dashboard.
  useEffect(() => {
    const timer = setInterval(() => {
      reloadDashboard()
      reloadMissed()
      reloadDay()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [reloadDashboard, reloadMissed, reloadDay])

  const data = dashboard.data
  const kpi = data?.kpi
  const missedChecks = useMemo(() => missed.data ?? [], [missed.data])
  const missedOnDay = missedChecks.filter((c) => dateKey(new Date(c.scheduledAt)) === date)
  const repeatMachines = repeated(missedChecks, (c) => ({ key: c.machineId, name: c.machineName, detail: c.machineCode }))
  const repeatWorkers = repeated(missedChecks, (c) => ({ key: c.submittedById ?? c.workerId ?? '—', name: workerOf(c), detail: c.workerEmployeeId }))
  const awaitingReview = (exceptions.data ?? []).filter((e) => e.status === 'UNDER_REVIEW')

  // Manager: each worker's day.
  const team = useMemo(() => {
    const map = new Map<string, { key: string; name: string; employeeId: string | null; total: number; completed: number; missed: number; exceptions: number; open: number }>()
    for (const c of dayChecks.data ?? []) {
      const key = c.submittedById ?? c.workerId ?? '—'
      const row = map.get(key) ?? { key, name: workerOf(c), employeeId: c.submittedByEmployeeId ?? c.workerEmployeeId, total: 0, completed: 0, missed: 0, exceptions: 0, open: 0 }
      row.total++
      if (c.result === 'COMPLETED') row.completed++
      else if (c.result === 'MISSED') row.missed++
      else if (c.result === 'EXCEPTION') row.exceptions++
      else row.open++
      map.set(key, row)
    }
    return [...map.values()].sort((a, b) => b.missed - a.missed || a.name.localeCompare(b.name))
  }, [dayChecks.data])

  const machines = useMemo(
    () => [...(data?.byMachine ?? [])].sort((a, b) => b.missed + b.exceptions - (a.missed + a.exceptions) || a.machineName.localeCompare(b.machineName)),
    [data?.byMachine]
  )

  const workersWithoutMachines = (workers.data ?? []).filter((w) => w.isActive && w.machineIds.length === 0)
  const nextYear = new Date().getFullYear() + 1
  const nextYearCalendar = (years.data?.years ?? []).find((y) => y.year === nextYear)
  const needsNextYear = years.data && new Date().getMonth() >= 9 && (!nextYearCalendar || nextYearCalendar.status !== 'APPROVED')

  const hour = new Date().getHours()
  const greeting = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, ${profile.name.split(' ')[0]}`
  const dayLabel = isToday ? 'today' : formatKey(date)

  const openChecks = (params: Record<string, unknown>) => switchTab('checks', { name: 'checks', params: { date, ...params } })
  const todayLong = formatLongDate(new Date())

  // ---- warnings (setup problems someone can act on), shown as one compact group
  const warnings: Warning[] = []
  if (data && (data.workerGaps ?? []).length > 0 && (isAdmin || can('schedules') || can('assignments'))) {
    warnings.push({
      key: 'gaps',
      tone: 'missed',
      title: `${data.workerGaps.length === 1 ? 'Shift with no worker' : `${data.workerGaps.length} shifts with no worker`}: checks are not scheduled`,
      message: [...new Set(data.workerGaps.map((g) => `${g.machineName} · ${g.shiftName}`))].join(', '),
      action: can('assignments') ? { label: 'Machine Assignment', onPress: () => push('assignments') } : null
    })
  }
  if (isAdmin && workersWithoutMachines.length > 0) {
    warnings.push({
      key: 'workers',
      tone: 'exception',
      title: `${workersWithoutMachines.length} active worker${workersWithoutMachines.length === 1 ? ' has' : 's have'} no machine`,
      message: workersWithoutMachines.map((w) => w.name).join(', '),
      action: { label: 'Assign machines', onPress: () => push('assignments') }
    })
  }
  if (needsNextYear) {
    warnings.push({
      key: 'calendar',
      tone: 'due',
      title: `${nextYear} company calendar ${nextYearCalendar ? 'is not approved yet' : 'has not been created'}`,
      message: 'Holidays and adjustment working days only apply once the calendar is approved.',
      action: { label: 'Annual calendars', onPress: () => push('calendarYears') }
    })
  }
  const hiddenWarnings = warnings.length - WARNINGS_SHOWN

  // ---- needs attention: top missed checks of the day and exceptions awaiting review, in one group
  const showAttention = can('exceptions') || canList
  const attentionLoading = (can('exceptions') && exceptions.loading && !exceptions.data) || (canList && missed.loading && !missed.data)
  const attentionLoaded = (!can('exceptions') || !!exceptions.data) && (!canList || !!missed.data)
  const allClear = attentionLoaded && (!can('exceptions') || awaitingReview.length === 0) && (!canList || missedOnDay.length === 0)
  const todayKey = dateKey()
  const exceptionWhen = (e: ExceptionRecord) => (dateKey(new Date(e.createdAt)) === todayKey ? formatTime(e.createdAt) : formatKey(dateKey(new Date(e.createdAt))))

  // ---- machines: only the ones with problems until "See all"
  const problemMachines = machines.filter((m) => m.missed + m.exceptions > 0)
  const shownMachines = showAllMachines ? machines : problemMachines.slice(0, MACHINE_ROWS)
  const repeatRows = [...repeatMachines.slice(0, 5).map((r) => ({ ...r, kind: 'Machine' })), ...repeatWorkers.slice(0, 5).map((r) => ({ ...r, kind: 'Worker' }))]

  return (
    <Screen title={greeting} subtitle={`${ROLE_LABEL[profile.role]} · ${todayLong}`} onRefresh={reloadAll} refreshing={dashboard.loading && !!data}>
      {monitoring ? (
        <View className="-mt-2 flex-row flex-wrap items-center gap-2">
          <DateField label="Day" variant="chip" chipLabel={isToday ? 'Today' : formatKey(date)} value={date} max={addDaysKey(dateKey(), 7)} onChange={(d) => d && setDate(d)} />
          {!isToday ? <LinkButton label="Back to today" onPress={() => setDate(dateKey())} className="px-1" /> : null}
        </View>
      ) : null}

      {/* 1. Setup warnings: at most two, the rest behind "Show more" */}
      {warnings.length > 0 ? (
        <Card>
          {(showAllWarnings ? warnings : warnings.slice(0, WARNINGS_SHOWN)).map((w, i) => (
            <React.Fragment key={w.key}>
              {i > 0 ? <View className="ml-12 h-px bg-staff-line" /> : null}
              <WarningRow warning={w} />
            </React.Fragment>
          ))}
          {hiddenWarnings > 0 ? (
            <>
              <View className="h-px bg-staff-line" />
              <ListFooterLink
                label={showAllWarnings ? 'Show fewer' : `Show ${hiddenWarnings} more`}
                icon={showAllWarnings ? 'chevron-up' : 'chevron-down'}
                onPress={() => setShowAllWarnings((v) => !v)}
              />
            </>
          ) : null}
        </Card>
      ) : null}

      {/* 2. Today: completion and the four figures, each opening the matching list */}
      {monitoring ? (
        <DataState loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.reload} hasData={!!data}>
          <View className="gap-3">
            {data?.closure ? (
              <Notice
                icon="moon-outline"
                title={`Plant closed ${isToday ? 'today' : `on ${formatKey(date)}`} · ${data.closure.label}${data.closure.reason ? ` · ${data.closure.reason}` : ''}`}
                message={
                  data.machinePlan?.count
                    ? `Only the ${data.machinePlan.count} machine${data.machinePlan.count === 1 ? '' : 's'} in the machine plan run${data.machinePlan.count === 1 ? 's' : ''} on this day; every other machine has no checks and no alerts.`
                    : 'No checks are scheduled, no alerts are sent and nothing is marked Missed on this day.'
                }
              />
            ) : null}
            {data?.machinePlan && !data.closure ? (
              <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">{`${data.machinePlan.count} machine${data.machinePlan.count === 1 ? '' : 's'} scheduled ${isToday ? 'today' : `on ${formatKey(date)}`} · machine plan`}</Text>
            ) : null}
            {kpi && (!data?.closure || kpi.scheduled > 0) ? (
              <MetricCard
                label={isToday ? 'Today' : formatKey(date)}
                value={kpi.completionRate}
                suffix="%"
                caption={`${kpi.completed} of ${kpi.scheduled} checks done`}
                progress={kpi.completionRate}
              >
                <MiniStat label="Completed" value={kpi.completed} tone="success" onPress={checksTab ? () => openChecks({ result: 'COMPLETED' }) : undefined} />
                <MiniStat label="Open" value={kpi.open} tone="neutral" onPress={checksTab ? () => openChecks({}) : undefined} />
                <MiniStat label="Missed" value={kpi.missed} tone="missed" onPress={checksTab ? () => openChecks({ result: 'MISSED' }) : undefined} />
                <MiniStat label="Exceptions" value={kpi.exceptions} tone="exception" onPress={exceptionsTab ? () => switchTab('exceptions') : undefined} />
              </MetricCard>
            ) : null}
          </View>
        </DataState>
      ) : null}

      {/* 3. Needs attention */}
      {showAttention ? (
        <Section title="Needs attention">
          {attentionLoading ? (
            <SkeletonRows rows={3} />
          ) : allClear ? (
            <Empty title="All clear" text={`Nothing awaits review and no checks were missed ${dayLabel}.`} icon="checkmark-circle-outline" />
          ) : (
            <View className="gap-3">
              {can('exceptions') && exceptions.error && !exceptions.data ? (
                <DataState loading={false} error={exceptions.error} onRetry={exceptions.reload} hasData={false}>
                  {null}
                </DataState>
              ) : null}
              {canList && missed.error && !missed.data ? (
                <DataState loading={false} error={missed.error} onRetry={missed.reload} hasData={false}>
                  {null}
                </DataState>
              ) : null}
              {missedOnDay.length > 0 || awaitingReview.length > 0 ? (
                <List>
                  {canList
                    ? missedOnDay.slice(0, ATTENTION_ROWS).map((c) => (
                        <Row
                          key={c.id}
                          title={c.machineName}
                          subtitle={`${c.activityName} · ${formatTime(c.scheduledAt)}`}
                          accessibilityLabel={`${c.machineName} · ${c.activityName}`}
                          right={<Badge dot label="Missed" tone="missed" />}
                          onPress={() => push('checkDetail', { id: c.id })}
                        />
                      ))
                    : null}
                  {can('exceptions')
                    ? awaitingReview.slice(0, ATTENTION_ROWS).map((e) => (
                        <Row
                          key={e.id}
                          title={e.machineName}
                          subtitle={`${e.activityName} · ${exceptionWhen(e)}`}
                          accessibilityLabel={`${e.machineName} · ${e.activityName}`}
                          right={<Badge dot label="Exception" tone="exception" />}
                          onPress={() => push('exceptionDetail', { id: e.id, from: dateKey(new Date(e.createdAt)) })}
                        />
                      ))
                    : null}
                  {canList && checksTab && missedOnDay.length > 0 ? (
                    <ListFooterLink label={`See all missed checks (${missedOnDay.length})`} accessibilityLabel="See all missed checks" onPress={() => openChecks({ result: 'MISSED' })} />
                  ) : null}
                  {can('exceptions') && exceptionsTab && awaitingReview.length > 0 ? (
                    <ListFooterLink
                      label={`See all exceptions awaiting review (${awaitingReview.length})`}
                      accessibilityLabel="See all exceptions awaiting review"
                      onPress={() => switchTab('exceptions', { name: 'exceptions', params: { status: 'UNDER_REVIEW', from: addDaysKey(dateKey(), -29), to: dateKey() } })}
                    />
                  ) : null}
                </List>
              ) : null}
            </View>
          )}
        </Section>
      ) : null}

      {/* 4. Admin: only machines with problems, all of them behind "See all" */}
      {isAdmin && data && machines.length > 0 ? (
        <Section
          title="Machines"
          seeAll={machines.length > shownMachines.length || showAllMachines ? { label: showAllMachines ? 'Show less' : 'See all', onPress: () => setShowAllMachines((v) => !v) } : null}
        >
          <List>
            {shownMachines.length === 0 ? (
              <Row title="No problems" subtitle={`${plural(machines.length, 'machine')} · nothing missed, no exceptions`} />
            ) : (
              shownMachines.map((m) => {
                const pct = m.total ? Math.round((m.completed / m.total) * 100) : 0
                const facts = [
                  `${m.completed}/${m.total} done`,
                  m.missed ? `${m.missed} missed` : null,
                  m.exceptions ? plural(m.exceptions, 'exception') : null,
                  repeatMachines.some((r) => r.key === m.machineId) ? 'repeat misses' : null
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <Row
                    key={m.machineId}
                    title={m.machineName}
                    subtitle={facts}
                    accessibilityLabel={`${m.machineName}, ${m.completed} of ${m.total} completed`}
                    right={<Text className="text-[15px] font-medium text-staff-muted">{`${pct}%`}</Text>}
                    onPress={checksTab ? () => openChecks({ machineId: m.machineId }) : undefined}
                  />
                )
              })
            )}
          </List>
        </Section>
      ) : null}

      {/* Manager: the team's day */}
      {!isAdmin && canList ? (
        <Section title="Team" seeAll={team.length > TOP_ROWS ? { label: showAllTeam ? 'Show less' : 'See all', onPress: () => setShowAllTeam((v) => !v) } : null}>
          <DataState loading={dayChecks.loading} error={dayChecks.error} onRetry={dayChecks.reload} hasData={!!dayChecks.data} empty={!!dayChecks.data && team.length === 0} emptyText="No checks scheduled for this day." emptyIcon="people-outline">
            <List>
              {(showAllTeam ? team : team.slice(0, TOP_ROWS)).map((w) => (
                <Row
                  key={w.key}
                  title={w.name}
                  subtitle={`${w.completed} of ${w.total} done${w.open ? ` · ${w.open} open` : ''}${w.employeeId ? ` · ${w.employeeId}` : ''}`}
                  right={
                    w.missed ? (
                      <Badge dot label={`${w.missed} missed`} tone="missed" />
                    ) : w.exceptions ? (
                      <Badge dot label={plural(w.exceptions, 'exception')} tone="exception" />
                    ) : (
                      <Badge dot label="On track" tone="success" />
                    )
                  }
                />
              ))}
            </List>
          </DataState>
        </Section>
      ) : null}

      {/* Repeated misses, collapsed to one line */}
      {canList && missed.data && repeatRows.length > 0 ? (
        <Card>
          <Pressable
            onPress={() => setShowRepeats((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showRepeats }} aria-expanded={showRepeats}
            accessibilityLabel={`Repeated misses: ${repeatMachines.length} machines, ${repeatWorkers.length} workers`}
            className="min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:bg-staff-fill"
          >
            <Icon name="repeat-outline" size={22} color="missed" />
            <View className="flex-1">
              <Text className="text-[16px] font-semibold leading-[21px] text-staff-ink">Repeated misses</Text>
              <Text className="text-[14px] leading-[19px] text-staff-muted" numberOfLines={1}>
                {`${plural(repeatMachines.length, 'machine')} · ${plural(repeatWorkers.length, 'worker')} · ${REPEAT_WINDOW_DAYS} days`}
              </Text>
            </View>
            <Icon name={showRepeats ? 'chevron-up' : 'chevron-down'} size={16} color="faint" />
          </Pressable>
          {showRepeats ? (
            <View className="border-t border-staff-line">
              <Text className="px-4 pt-3 text-[13px] leading-[18px] text-staff-muted">{`2 or more missed checks in the ${REPEAT_WINDOW_DAYS} days to ${formatKey(date)}`}</Text>
              {repeatRows.map((r) => (
                <Row key={`${r.kind}-${r.key}`} title={r.name} subtitle={`${r.kind}${r.detail ? ` · ${r.detail}` : ''}`} right={<Badge label={`${r.total}×`} tone="missed" />} />
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* No monitoring access: welcome card and what this account can open */}
      {!monitoring && !canList ? (
        <>
          <Notice title="No monitoring access" message="Your account has no access to the dashboard or quality checks. Open More to see what you can use, or ask an Admin." />
          {modules.data && modules.data.some((m) => (profile.permissions?.[m.key] ?? 'none') !== 'none') ? (
            <Section title="You can use" seeAll={{ label: 'All modules', onPress: () => switchTab('more') }}>
              <List>
                {modules.data
                  .filter((m) => (profile.permissions?.[m.key] ?? 'none') !== 'none')
                  .map((m) => {
                    const manage = profile.permissions?.[m.key] === 'manage'
                    return <Row key={m.key} title={m.label} right={<Badge label={manage ? 'View & manage' : 'View only'} tone={manage ? 'success' : 'neutral'} />} />
                  })}
              </List>
            </Section>
          ) : null}
        </>
      ) : null}

      {monitoring ? <Text className="text-center text-[12px] leading-[16px] text-staff-muted">Updates every minute · pull down to refresh</Text> : null}
    </Screen>
  )
}

interface Warning {
  key: string
  tone: 'missed' | 'exception' | 'due'
  title: string
  message: string
  action: { label: string; onPress: () => void } | null
}

/** One setup warning: coloured icon, short title, two-line detail and a plain accent action. */
const WarningRow: React.FC<{ warning: Warning }> = ({ warning: w }) => (
  <View className="flex-row gap-3 px-4 py-3" accessibilityRole="summary">
    <View className="pt-0.5">
      <Icon name={w.tone === 'due' ? 'calendar-outline' : 'warning-outline'} size={20} color={w.tone} />
    </View>
    <View className="flex-1">
      <Text className="text-[15px] font-semibold leading-[20px] text-staff-ink">{w.title}</Text>
      <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted" numberOfLines={2}>
        {w.message}
      </Text>
      {w.action ? <LinkButton label={w.action.label} onPress={w.action.onPress} className="-mb-2 self-start" /> : null}
    </View>
  </View>
)
