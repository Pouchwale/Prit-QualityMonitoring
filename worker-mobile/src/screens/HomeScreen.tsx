import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, getMyMachines, getPlantStatus, getTodayChecks, type PlantStatus } from '../services/api'
import { CheckSummary, Profile } from '../types'
import { formatDate, formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { syncLocalAlerts } from '../services/notifications'
import { LargeHeader } from '../components/ui/LargeHeader'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'

export interface AssignedMachine {
  id: string
  name: string
  code: string
}

interface Props {
  profile: Profile
  refreshKey: number
  onOpenMachine: (machine: AssignedMachine) => void
}

/** What a machine needs from the worker right now, shown on its row. */
function machineState(checks: CheckSummary[], plantClosed: boolean) {
  const due = checks.filter((c) => c.canSubmit)
  if (due.length) return { label: due.length === 1 ? '1 check due' : `${due.length} checks due`, tone: 'due' as const }
  if (plantClosed) return { label: 'Plant closed', tone: 'none' as const }
  const next = checks.find((c) => c.status === 'PENDING')
  if (next) return { label: `Next at ${formatTime(next.scheduledAt)}`, tone: 'later' as const }
  if (checks.length) return { label: 'All done today', tone: 'done' as const }
  return { label: 'No checks today', tone: 'none' as const }
}

const TONE: Record<'due' | 'later' | 'done' | 'none', { pill: string; text: string }> = {
  due: { pill: 'bg-due', text: 'text-white' },
  later: { pill: 'bg-subtle', text: 'text-ink-secondary' },
  done: { pill: 'bg-success-bg', text: 'text-success' },
  none: { pill: 'bg-subtle', text: 'text-ink-muted' }
}

/**
 * Step 1 of a check: the worker picks the machine they are standing at.
 * Only the machines the admin assigned to this worker are listed.
 */
export const HomeScreen: React.FC<Props> = ({ profile, refreshKey, onOpenMachine }) => {
  const insets = useSafeAreaInsets()
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
  const [checks, setChecks] = useState<CheckSummary[]>([])
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
      setChecks(today)
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

  const dueTotal = checks.filter((c) => c.canSubmit).length
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
        <LargeHeader eyebrow={formatDate(new Date())} title="Select Machine" subtitle={shift} />

        {machines === null && error ? (
          <ErrorState message={error} onRetry={load} />
        ) : machines === null ? (
          <Loading />
        ) : machines.length === 0 ? (
          <EmptyState title="No machine assigned" message="Ask your supervisor to assign your machine. Until then you get no checks." />
        ) : (
          <View className="gap-3">
            {plant.closed && !dueTotal ? (
              <View className="rounded-xl border border-line bg-subtle px-4 py-3.5" accessibilityRole="summary">
                <Text className="text-[17px] font-semibold text-ink">Plant closed today{plant.label ? ` · ${plant.label}` : ''}</Text>
                <Text className="mt-0.5 text-[15px] text-ink-muted">
                  {plant.reason ? `${plant.reason}. ` : ''}No quality checks are scheduled today.
                </Text>
              </View>
            ) : (
              <View
                className={`rounded-xl px-4 py-3.5 ${dueTotal ? 'border border-due-line bg-due-bg' : 'border border-line bg-surface'}`}
                accessibilityRole="summary"
              >
                <Text className={`text-[17px] font-semibold ${dueTotal ? 'text-due' : 'text-ink'}`}>
                  {dueTotal ? `${dueTotal} ${dueTotal === 1 ? 'check is' : 'checks are'} due now` : 'Nothing due right now'}
                </Text>
                <Text className="mt-0.5 text-[15px] text-ink-muted">Tap the machine you are working on.</Text>
              </View>
            )}

            <SectionHeader title="My machines" />
            <ListGroup>
              {machines.map((m) => {
                const state = machineState(checks.filter((c) => c.machineId === m.id), plant.closed)
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => onOpenMachine(m)}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.name}, ${state.label}`}
                    className="min-h-[76px] flex-row items-center px-4 py-3.5 active:bg-subtle"
                  >
                    <View className="flex-1">
                      <Text className="text-[19px] font-semibold text-ink" numberOfLines={1}>
                        {m.name}
                      </Text>
                      <Text className="mt-0.5 text-[14px] text-ink-muted">{m.code}</Text>
                    </View>
                    <View className={`ml-3 rounded-full px-3 py-1.5 ${TONE[state.tone].pill}`}>
                      <Text className={`text-[14px] font-semibold ${TONE[state.tone].text}`}>
                        {state.label}
                      </Text>
                    </View>
                    <Text className="ml-2 text-[24px] text-ink-faint">›</Text>
                  </Pressable>
                )
              })}
            </ListGroup>

            {error ? <Text className="px-4 text-[14px] text-failed">Could not refresh: {error}</Text> : null}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
