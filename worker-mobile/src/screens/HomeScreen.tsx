import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkerFeatures } from '../worker/features'
import { View, Text, ScrollView, RefreshControl, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getMyMachines, getPlantStatus, getTodayChecks, startManualCheck, type PlantStatus } from '../services/api'
import { showDialog, showError, showSuccess } from '../utils/dialog'
import { Button } from '../components/ui/Button'
import { MachinePickerModal } from './CheckScreen'
import { friendlyMessage } from '../utils/friendlyError'
import { AssignedMachine, CheckSummary, Profile } from '../types'
import { formatDate, formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { syncLocalAlerts } from '../services/notifications'
import { LargeHeader } from '../components/ui/LargeHeader'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { ScoreCard } from '../components/ScoreCard'
import { formatClockRange } from '../utils/datetime'

export type { AssignedMachine } from '../types'

interface Props {
  profile: Profile
  refreshKey: number
  onOpenMachine: (machine: AssignedMachine) => void
  onStartCheck?: (checkId: string, startWith?: 'exception') => void
}

type ModuleFilter = 'ALL' | 'IPQC' | 'QC'
type SectionTab = 'ALL' | 'DUE' | 'UPCOMING' | 'COMPLETED' | 'MISSED'

export const HomeScreen: React.FC<Props> = ({ profile, refreshKey, onOpenMachine, onStartCheck }) => {
  const features = useWorkerFeatures()
  const insets = useSafeAreaInsets()
  const [checks, setChecks] = useState<CheckSummary[] | null>(null)
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [machinesError, setMachinesError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [plant, setPlant] = useState<PlantStatus>({ closed: false })
  const [moduleFilter, setModuleFilter] = useState<ModuleFilter>('ALL')
  const [sectionTab, setSectionTab] = useState<SectionTab>('ALL')

  const [pickingMachine, setPickingMachine] = useState(false)
  const [startingManual, setStartingManual] = useState(false)

  const workerQualityRole = profile.workerQualityRole ?? 'IPQC'
  const hasBothRoles = workerQualityRole === 'BOTH'

  /**
   * Counts the loads: an answer that arrives after a newer load started (a slow refresh, then a
   * pull to refresh) is dropped, so older data never replaces newer data.
   */
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const [today, mine, status] = await Promise.all([
        getTodayChecks(),
        // A failure keeps the machines already shown (and says so) instead of showing none.
        getMyMachines().then(
          (list) => ({ list, error: null }),
          (err: unknown) => ({ list: null, error: friendlyMessage(err) })
        ),
        getPlantStatus().catch(() => ({ closed: false }) as PlantStatus)
      ])
      if (id !== requestId.current) return
      setChecks(today)
      if (mine.list) setMachines(mine.list)
      setMachinesError(mine.error)
      setPlant(status)
      setError(null)
      syncLocalAlerts(today)
    } catch (err) {
      if (id === requestId.current) setError(friendlyMessage(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useAutoRefresh(load)

  /**
   * Manual Start: the worker picks only a machine and its check starts now, without waiting for
   * the schedule. The server reuses an open check, so a machine never gets two (routes/worker.ts).
   */
  const manualStart = async (machineId: string) => {
    setPickingMachine(false)
    const m = machines?.find((x) => x.id === machineId)
    if (!m || startingManual) return
    const ready = m.checkTypes.filter((t) => t.openCheck?.canSubmit || t.canStart)
    // Several check types on this machine: its screen lists them to choose from.
    if (ready.length > 1) return onOpenMachine(m)
    const type = ready[0]
    if (!type) {
      return showDialog('Cannot start a check', m.checkTypes[0]?.startMessage ?? `No quality check can be started on ${m.name} now.`)
    }
    setStartingManual(true)
    try {
      const id = type.openCheck?.canSubmit ? type.openCheck.id : (await startManualCheck(m.id, type.activityId)).id
      load()
      showSuccess('Check started', `${type.activityName} started on ${m.name}.`, () => onStartCheck?.(id))
    } catch (err) {
      showError(err, { title: 'Could not start the check' })
    } finally {
      setStartingManual(false)
    }
  }

  const onPullRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // Filter checks by module tab (if worker has BOTH)
  const filteredChecks = useMemo(() => {
    if (!checks) return []
    return checks.filter((c) => {
      const m = c.module ?? 'IPQC'
      if (moduleFilter !== 'ALL' && m !== moduleFilter) return false
      return true
    })
  }, [checks, moduleFilter])

  // Categorize checks
  const dueChecks = useMemo(
    () => filteredChecks.filter((c) => c.status === 'DUE' || c.status === 'IN_PROGRESS' || (c.status === 'PENDING' && c.canSubmit)),
    [filteredChecks]
  )
  const upcomingChecks = useMemo(
    () => filteredChecks.filter((c) => c.status === 'PENDING' && !c.canSubmit),
    [filteredChecks]
  )
  // An exception is a reasoned "could not do it": counted as done, never as missed (the same rule as
  // the score, backend services/performance.ts). It is listed with the done checks, marked Exception.
  const isException = (c: CheckSummary) => c.status === 'EXCEPTION' || c.result === 'EXCEPTION'
  const completedChecks = useMemo(
    () => filteredChecks.filter((c) => c.status === 'COMPLETED' || c.result === 'COMPLETED' || isException(c)),
    [filteredChecks]
  )
  const missedChecks = useMemo(
    () => filteredChecks.filter((c) => !isException(c) && (c.status === 'MISSED' || c.result === 'MISSED')),
    [filteredChecks]
  )

  const shift = profile.shiftName
    ? `${profile.shiftName}${profile.shiftStartTime ? ` · ${formatClockRange(profile.shiftStartTime, profile.shiftEndTime)}` : ''}`
    : profile.departmentName ?? profile.name

  const showDue = sectionTab === 'ALL' || sectionTab === 'DUE'
  const showUpcoming = sectionTab === 'ALL' || sectionTab === 'UPCOMING'
  const showCompleted = sectionTab === 'ALL' || sectionTab === 'COMPLETED'
  const showMissed = sectionTab === 'ALL' || sectionTab === 'MISSED'

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} />}
      >
        <View className="flex-row items-center">
          <View className="flex-1">
            <LargeHeader eyebrow={formatDate(new Date())} title={profile.name}>
              <View className="mt-1 flex-row items-center gap-2">
                <View
                  className={`px-2 py-0.5 rounded border ${
                    workerQualityRole === 'BOTH'
                      ? 'bg-emerald-50 border-emerald-200'
                      : workerQualityRole === 'QC'
                        ? 'bg-indigo-50 border-indigo-200'
                        : 'bg-blue-50 border-blue-200'
                  }`}
                >
                  <Text
                    className={`text-[12px] font-bold ${
                      workerQualityRole === 'BOTH'
                        ? 'text-emerald-700'
                        : workerQualityRole === 'QC'
                          ? 'text-indigo-700'
                          : 'text-blue-700'
                    }`}
                  >
                    {workerQualityRole === 'BOTH' ? 'IPQC + QC' : workerQualityRole}
                  </Text>
                </View>
                <Text className="text-[14px] text-ink-secondary" numberOfLines={1}>
                  {shift}
                </Text>
              </View>
            </LargeHeader>
          </View>
          {features.performance ? <ScoreCard refreshKey={refreshKey} /> : null}
        </View>

        {/* Quality Role Tabs when worker has BOTH roles */}
        {hasBothRoles && (
          <View className="mt-4 flex-row rounded-xl border border-line bg-surface p-1">
            {(['ALL', 'IPQC', 'QC'] as ModuleFilter[]).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => setModuleFilter(tab)}
                className={`flex-1 items-center justify-center py-2 rounded-lg ${
                  moduleFilter === tab ? 'bg-accent shadow-xs' : 'bg-transparent'
                }`}
              >
                <Text className={`text-[13px] font-semibold ${moduleFilter === tab ? 'text-white' : 'text-ink-secondary'}`}>
                  {tab === 'ALL' ? 'All Modules' : tab}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Section Pill Badges for Quick Filtering */}
        <View className="mt-3 flex-row gap-2">
          <Pressable
            onPress={() => setSectionTab('ALL')}
            className={`flex-1 items-center py-2 px-1 rounded-lg border ${
              sectionTab === 'ALL' ? 'bg-ink border-ink' : 'bg-surface border-line'
            }`}
          >
            <Text className={`text-[11px] font-semibold ${sectionTab === 'ALL' ? 'text-white' : 'text-ink'}`}>All</Text>
            <Text className={`text-[13px] font-bold ${sectionTab === 'ALL' ? 'text-white' : 'text-ink'}`}>{filteredChecks.length}</Text>
          </Pressable>

          <Pressable
            onPress={() => setSectionTab(sectionTab === 'DUE' ? 'ALL' : 'DUE')}
            className={`flex-1 items-center py-2 px-1 rounded-lg border ${
              sectionTab === 'DUE' ? 'bg-due border-due' : 'bg-surface border-line'
            }`}
          >
            <Text className={`text-[11px] font-semibold ${sectionTab === 'DUE' ? 'text-white' : 'text-due'}`}>Due</Text>
            <Text className={`text-[13px] font-bold ${sectionTab === 'DUE' ? 'text-white' : 'text-due'}`}>{dueChecks.length}</Text>
          </Pressable>

          <Pressable
            onPress={() => setSectionTab(sectionTab === 'UPCOMING' ? 'ALL' : 'UPCOMING')}
            className={`flex-1 items-center py-2 px-1 rounded-lg border ${
              sectionTab === 'UPCOMING' ? 'bg-accent border-accent' : 'bg-surface border-line'
            }`}
          >
            <Text className={`text-[11px] font-semibold ${sectionTab === 'UPCOMING' ? 'text-white' : 'text-ink-muted'}`}>Upcoming</Text>
            <Text className={`text-[13px] font-bold ${sectionTab === 'UPCOMING' ? 'text-white' : 'text-ink-muted'}`}>{upcomingChecks.length}</Text>
          </Pressable>

          <Pressable
            onPress={() => setSectionTab(sectionTab === 'COMPLETED' ? 'ALL' : 'COMPLETED')}
            className={`flex-1 items-center py-2 px-1 rounded-lg border ${
              sectionTab === 'COMPLETED' ? 'bg-success border-success' : 'bg-surface border-line'
            }`}
          >
            <Text className={`text-[11px] font-semibold ${sectionTab === 'COMPLETED' ? 'text-white' : 'text-success'}`}>Done</Text>
            <Text className={`text-[13px] font-bold ${sectionTab === 'COMPLETED' ? 'text-white' : 'text-success'}`}>{completedChecks.length}</Text>
          </Pressable>

          <Pressable
            onPress={() => setSectionTab(sectionTab === 'MISSED' ? 'ALL' : 'MISSED')}
            className={`flex-1 items-center py-2 px-1 rounded-lg border ${
              sectionTab === 'MISSED' ? 'bg-missed border-missed' : 'bg-surface border-line'
            }`}
          >
            <Text className={`text-[11px] font-semibold ${sectionTab === 'MISSED' ? 'text-white' : 'text-missed'}`}>Missed</Text>
            <Text className={`text-[13px] font-bold ${sectionTab === 'MISSED' ? 'text-white' : 'text-missed'}`}>{missedChecks.length}</Text>
          </Pressable>
        </View>

        <View className="mt-4">
          <Button
            label="Manual Start"
            icon="play-circle-outline"
            variant="secondary"
            loading={startingManual}
            // Enabled once loaded, even with no machines: the picker then says none are assigned.
            disabled={machines === null}
            accessibilityLabel="Manual Start: choose a machine and start its check now"
            onPress={() => setPickingMachine(true)}
          />
        </View>

        {checks === null && error ? (
          <View className="mt-6">
            <ErrorState message={error} onRetry={load} />
          </View>
        ) : checks === null ? (
          <View className="mt-8">
            <Loading />
          </View>
        ) : filteredChecks.length === 0 ? (
          <View className="mt-6">
            <EmptyState
              icon="calendar-outline"
              title="No checks scheduled"
              message="No quality checks are scheduled for you today. Ask your supervisor if checks should be configured."
              action={{ label: 'Refresh', onPress: load }}
            />
          </View>
        ) : (
          <View className="mt-6 gap-6">
            {/* 1. DUE CHECKS */}
            {showDue && dueChecks.length > 0 && (
              <View>
                <SectionHeader size="large" title="Due Checks" detail={`${dueChecks.length} ready`} />
                <ListGroup>
                  {dueChecks.map((c) => {
                    const mod = c.module ?? 'IPQC'
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => onStartCheck?.(c.id)}
                        className="min-h-[72px] flex-row items-center py-3 pl-4 pr-3 active:bg-subtle"
                      >
                        <View className="mr-3 h-3 w-3 rounded-full bg-due" />
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <View
                              className={`px-1.5 py-0.2 rounded border ${
                                mod === 'QC' ? 'bg-indigo-50 border-indigo-200' : 'bg-blue-50 border-blue-200'
                              }`}
                            >
                              <Text className={`text-[10px] font-bold ${mod === 'QC' ? 'text-indigo-700' : 'text-blue-700'}`}>
                                {mod}
                              </Text>
                            </View>
                            <Text className="text-[17px] font-semibold text-ink" numberOfLines={1}>
                              {c.activityName}
                            </Text>
                          </View>
                          <Text className="mt-0.5 text-[14px] text-due" numberOfLines={1}>
                            Due now · until {formatTime(c.windowEndsAt)}
                            {c.departmentName ? ` · ${c.departmentName}` : ''}
                          </Text>
                        </View>
                        <View className="ml-2 flex-row items-center rounded-lg bg-due px-3 py-1.5">
                          <Text className="text-[13px] font-bold text-white">Start</Text>
                          <Icon name="chevron-forward" size={14} color="white" />
                        </View>
                      </Pressable>
                    )
                  })}
                </ListGroup>
              </View>
            )}

            {/* 2. UPCOMING CHECKS */}
            {showUpcoming && upcomingChecks.length > 0 && (
              <View>
                <SectionHeader size="large" title="Upcoming Checks" detail={`${upcomingChecks.length} scheduled`} />
                <ListGroup>
                  {upcomingChecks.map((c) => {
                    const mod = c.module ?? 'IPQC'
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => onStartCheck?.(c.id)}
                        className="min-h-[64px] flex-row items-center py-3 pl-4 pr-3 active:bg-subtle"
                      >
                        <View className="mr-3 h-2.5 w-2.5 rounded-full bg-line-strong" />
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <View
                              className={`px-1.5 py-0.2 rounded border ${
                                mod === 'QC' ? 'bg-indigo-50 border-indigo-200' : 'bg-blue-50 border-blue-200'
                              }`}
                            >
                              <Text className={`text-[10px] font-bold ${mod === 'QC' ? 'text-indigo-700' : 'text-blue-700'}`}>
                                {mod}
                              </Text>
                            </View>
                            <Text className="text-[16px] font-medium text-ink" numberOfLines={1}>
                              {c.activityName}
                            </Text>
                          </View>
                          <Text className="mt-0.5 text-[13px] text-ink-muted" numberOfLines={1}>
                            Scheduled for {formatTime(c.scheduledAt)}
                            {c.departmentName ? ` · ${c.departmentName}` : ''}
                          </Text>
                        </View>
                        <Icon name="time-outline" size={16} color="muted" />
                      </Pressable>
                    )
                  })}
                </ListGroup>
              </View>
            )}

            {/* 3. COMPLETED CHECKS */}
            {showCompleted && completedChecks.length > 0 && (
              <View>
                <SectionHeader size="large" title="Completed Checks" detail={`${completedChecks.length} done`} />
                <ListGroup>
                  {completedChecks.map((c) => {
                    const mod = c.module ?? 'IPQC'
                    return (
                      <View key={c.id} className="min-h-[64px] flex-row items-center py-3 pl-4 pr-3">
                        <View className={`mr-3 h-5 w-5 items-center justify-center rounded-full ${isException(c) ? 'bg-exception-bg' : 'bg-success-bg'}`}>
                          <Icon name={isException(c) ? 'alert' : 'checkmark'} size={12} color={isException(c) ? 'exception' : 'success'} />
                        </View>
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <View
                              className={`px-1.5 py-0.2 rounded border ${
                                mod === 'QC' ? 'bg-indigo-50 border-indigo-200' : 'bg-blue-50 border-blue-200'
                              }`}
                            >
                              <Text className={`text-[10px] font-bold ${mod === 'QC' ? 'text-indigo-700' : 'text-blue-700'}`}>
                                {mod}
                              </Text>
                            </View>
                            <Text className="text-[16px] font-medium text-ink" numberOfLines={1}>
                              {c.activityName}
                            </Text>
                          </View>
                          <Text className="mt-0.5 text-[13px] text-ink-secondary" numberOfLines={1}>
                            Submitted {c.submittedAt ? formatTime(c.submittedAt) : 'today'}
                            {c.itemCode ? ` · Item: ${c.itemCode}` : ''}
                            {c.jobNo ? ` · PO: ${c.jobNo}` : ''}
                          </Text>
                        </View>
                        {isException(c) ? (
                          <View className="rounded px-2 py-0.5 bg-exception-bg">
                            <Text className="text-[11px] font-bold text-exception">Exception</Text>
                          </View>
                        ) : (
                          <View className="rounded px-2 py-0.5 bg-success-bg">
                            <Text className="text-[11px] font-bold text-success">Done</Text>
                          </View>
                        )}
                      </View>
                    )
                  })}
                </ListGroup>
              </View>
            )}

            {/* 4. MISSED CHECKS */}
            {showMissed && missedChecks.length > 0 && (
              <View>
                <SectionHeader size="large" title="Missed Checks" detail={`${missedChecks.length} missed`} />
                <ListGroup>
                  {missedChecks.map((c) => {
                    const mod = c.module ?? 'IPQC'
                    return (
                      <View key={c.id} className="min-h-[64px] flex-row items-center py-3 pl-4 pr-3">
                        <View className="mr-3 h-5 w-5 items-center justify-center rounded-full bg-missed-bg">
                          <Icon name="close" size={12} color="missed" />
                        </View>
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <View
                              className={`px-1.5 py-0.2 rounded border ${
                                mod === 'QC' ? 'bg-indigo-50 border-indigo-200' : 'bg-blue-50 border-blue-200'
                              }`}
                            >
                              <Text className={`text-[10px] font-bold ${mod === 'QC' ? 'text-indigo-700' : 'text-blue-700'}`}>
                                {mod}
                              </Text>
                            </View>
                            <Text className="text-[16px] font-medium text-ink" numberOfLines={1}>
                              {c.activityName}
                            </Text>
                          </View>
                          <Text className="mt-0.5 text-[13px] text-missed" numberOfLines={1}>
                            Window expired ({formatTime(c.scheduledAt)} – {formatTime(c.windowEndsAt)})
                          </Text>
                        </View>
                        <View className="rounded px-2 py-0.5 bg-missed-bg">
                          <Text className="text-[11px] font-bold text-missed">Missed</Text>
                        </View>
                      </View>
                    )
                  })}
                </ListGroup>
              </View>
            )}

            {machinesError ? (
              <Text className="px-4 pt-2 text-[14px] text-missed">Could not load your machines: {machinesError}</Text>
            ) : null}

            {/* Legacy Machine access if machines exist */}
            {machines && machines.length > 0 && (
              <View className="pt-2">
                <SectionHeader title="Machines" detail={`${machines.length} active`} />
                <ListGroup>
                  {machines.slice(0, 5).map((m) => (
                    <Pressable
                      key={m.id}
                      onPress={() => onOpenMachine(m)}
                      className="min-h-[56px] flex-row items-center py-2.5 pl-4 pr-3 active:bg-subtle"
                    >
                      <Icon name="hardware-chip-outline" size={18} color="muted" />
                      <View className="ml-3 flex-1">
                        <Text className="text-[15px] font-medium text-ink" numberOfLines={1}>
                          {m.name}
                        </Text>
                        <Text className="text-[12px] text-ink-muted font-mono">{m.code}</Text>
                      </View>
                      <Icon name="chevron-forward" size={14} color="muted" />
                    </Pressable>
                  ))}
                </ListGroup>
              </View>
            )}
          </View>
        )}
      </ScrollView>
      <MachinePickerModal
        visible={pickingMachine}
        machines={machines ?? []}
        selectedId=""
        onSelect={manualStart}
        onClose={() => setPickingMachine(false)}
      />
    </View>
  )
}
