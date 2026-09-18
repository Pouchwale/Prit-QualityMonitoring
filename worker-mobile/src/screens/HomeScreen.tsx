import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, getMyMachines, getPlantStatus, getTodayChecks, type PlantStatus } from '../services/api'
import { AssignedMachine, Profile } from '../types'
import { formatDate, formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { syncLocalAlerts } from '../services/notifications'
import { LargeHeader } from '../components/ui/LargeHeader'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'

export type { AssignedMachine } from '../types'

interface Props {
  profile: Profile
  refreshKey: number
  onOpenMachine: (machine: AssignedMachine) => void
}

/** The checks the worker can submit on this machine right now. */
const dueChecks = (machine: AssignedMachine) =>
  machine.checkTypes.map((t) => t.openCheck).filter((c): c is NonNullable<typeof c> => !!c?.canSubmit)

/** The earliest upcoming check on a machine that is not due yet. */
const nextAt = (machine: AssignedMachine) =>
  machine.checkTypes
    .map((t) => t.openCheck?.scheduledAt ?? t.nextDueAt)
    .filter((at): at is string => !!at)
    .sort()[0] ?? null

/** Only what is worth saying about a machine that is not due: null when there is nothing informative. */
function quietStatus(machine: AssignedMachine, plantClosed: boolean): { text: string; tone: 'muted' | 'success' } | null {
  if (plantClosed) return { text: 'Plant closed', tone: 'muted' }
  if (machine.runningJob) return { text: `Job running · ${machine.runningJob.jobNo}`, tone: 'success' }
  const next = nextAt(machine)
  if (next) return { text: `Next at ${formatTime(next)}`, tone: 'muted' }
  return null
}

/** Due machines first (handled separately), then the next soonest check, then the rest by name. */
function byUrgency(a: AssignedMachine, b: AssignedMachine) {
  const na = nextAt(a)
  const nb = nextAt(b)
  if (na && nb) return na.localeCompare(nb)
  if (na) return -1
  if (nb) return 1
  return a.name.localeCompare(b.name)
}

/**
 * Step 1 of a check: the worker picks the machine they are standing at.
 * Only the machines the admin assigned to this worker are listed.
 */
export const HomeScreen: React.FC<Props> = ({ profile, refreshKey, onOpenMachine }) => {
  const insets = useSafeAreaInsets()
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [plant, setPlant] = useState<PlantStatus>({ closed: false })

  const load = useCallback(async () => {
    try {
      const [mine, today, status] = await Promise.all([
        getMyMachines(),
        getTodayChecks(),
        // An older server without the Plant Calendar simply shows no banner.
        getPlantStatus().catch(() => ({ closed: false }) as PlantStatus)
      ])
      setPlant(status)
      setMachines(mine)
      setError(null)
      // Alerts follow the list, which only holds the worker's assigned machines.
      syncLocalAlerts(today)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useAutoRefresh(load)

  const onPullRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const due = (machines ?? []).filter((m) => dueChecks(m).length > 0)
  const dueTotal = due.reduce((n, m) => n + dueChecks(m).length, 0)
  const others = (machines ?? []).filter((m) => dueChecks(m).length === 0).sort(byUrgency)
  const shift = profile.shiftName
    ? `${profile.shiftName}${profile.shiftStartTime ? ` · ${profile.shiftStartTime} – ${profile.shiftEndTime}` : ''}`
    : profile.name

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} />}
      >
        <LargeHeader eyebrow={formatDate(new Date())} title="Select Machine">
          <View className="mt-1.5 flex-row items-center">
            <Icon name="time-outline" size={16} color="muted" />
            <Text className="ml-1.5 flex-1 text-[15px] text-ink-secondary" numberOfLines={1}>
              {shift}
            </Text>
          </View>
        </LargeHeader>

        {machines === null && error ? (
          <ErrorState message={error} onRetry={load} />
        ) : machines === null ? (
          <Loading />
        ) : machines.length === 0 ? (
          <EmptyState
            icon="construct-outline"
            title="No machine assigned"
            message="Ask your supervisor to assign your machine. Until then you get no checks."
            action={{ label: 'Refresh', onPress: load }}
          />
        ) : (
          <View className="gap-7">
            {plant.closed && due.length === 0 ? (
              <View className="flex-row rounded-2xl bg-surface px-4 py-4" accessibilityRole="summary">
                <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-subtle">
                  <Icon name="moon-outline" size={20} color="secondary" />
                </View>
                <View className="flex-1">
                  <Text className="text-[17px] font-semibold text-ink">
                    Plant closed today{plant.label ? ` · ${plant.label}` : ''}
                  </Text>
                  <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-muted">
                    {plant.reason ? `${plant.reason}. ` : ''}No quality checks are scheduled today.
                  </Text>
                </View>
              </View>
            ) : null}

            {due.length > 0 ? (
              <View>
                <SectionHeader size="large" title="Due now" detail={dueTotal === 1 ? '1 check' : `${dueTotal} checks`} />
                <ListGroup>
                  {due.map((m) => {
                    const open = dueChecks(m)
                    const until = open.map((c) => c.windowEndsAt).sort()[0]
                    const count = open.length === 1 ? '1 check due' : `${open.length} checks due`
                    return (
                      <Pressable
                        key={m.id}
                        onPress={() => onOpenMachine(m)}
                        accessibilityRole="button"
                        accessibilityLabel={`${m.name}, ${count}${until ? ` until ${formatTime(until)}` : ''}`}
                        className="min-h-[72px] flex-row items-center py-3 pl-4 pr-3 active:bg-subtle"
                      >
                        <View className="mr-3 h-2.5 w-2.5 rounded-full bg-due" />
                        <View className="flex-1">
                          <Text className="text-[17px] font-semibold text-ink" numberOfLines={1}>
                            {m.name}
                          </Text>
                          <Text className="mt-0.5 text-[15px] text-due" numberOfLines={1}>
                            {count}
                            {until ? ` · until ${formatTime(until)}` : ''}
                          </Text>
                        </View>
                        <View className="ml-2">
                          <Icon name="chevron-forward" size={20} color="faint" />
                        </View>
                      </Pressable>
                    )
                  })}
                </ListGroup>
              </View>
            ) : !plant.closed ? (
              <View className="flex-row items-center rounded-2xl bg-surface px-4 py-3.5" accessibilityRole="summary">
                <Icon name="checkmark-circle" size={22} color="success" />
                <View className="ml-3 flex-1">
                  <Text className="text-[17px] font-semibold text-ink">Nothing due right now</Text>
                  <Text className="mt-0.5 text-[15px] text-ink-muted">Tap a machine to start a check.</Text>
                </View>
              </View>
            ) : null}

            {others.length > 0 ? (
              <View>
                <SectionHeader size="large" title={due.length ? 'Other machines' : 'My machines'} />
                <ListGroup>
                  {others.map((m) => {
                    const status = quietStatus(m, plant.closed)
                    return (
                      <Pressable
                        key={m.id}
                        onPress={() => onOpenMachine(m)}
                        accessibilityRole="button"
                        accessibilityLabel={`${m.name}, ${status?.text ?? 'Nothing due'}`}
                        className="min-h-[64px] flex-row items-center py-3 pl-4 pr-3 active:bg-subtle"
                      >
                        <View className="flex-1">
                          <Text className="text-[17px] font-semibold text-ink" numberOfLines={1}>
                            {m.name}
                          </Text>
                          <View className="mt-0.5 flex-row items-center">
                            <Text className="text-[15px] text-ink-muted">{m.code}</Text>
                            {status ? (
                              <>
                                <Text className="mx-1.5 text-[15px] text-ink-muted">·</Text>
                                {status.tone === 'success' ? <View className="mr-1.5 h-2 w-2 rounded-full bg-success" /> : null}
                                <Text
                                  className={`flex-1 text-[15px] ${status.tone === 'success' ? 'text-success' : 'text-ink-secondary'}`}
                                  numberOfLines={1}
                                >
                                  {status.text}
                                </Text>
                              </>
                            ) : null}
                          </View>
                        </View>
                        <View className="ml-2">
                          <Icon name="chevron-forward" size={20} color="faint" />
                        </View>
                      </Pressable>
                    )
                  })}
                </ListGroup>
              </View>
            ) : null}

            {error ? <Text className="px-4 text-[14px] text-missed">Could not refresh: {error}</Text> : null}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
