import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl } from 'react-native'
import { ApiError, getTodayChecks } from '../services/api'
import { CheckSummary } from '../types'
import { formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { CheckRow } from '../components/ui/CheckRow'
import { Button } from '../components/ui/Button'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import type { AssignedMachine } from './HomeScreen'

interface Props {
  machine: AssignedMachine
  refreshKey: number
  onBack: () => void
  /** Opens the check: "Click Image" starts with the camera, "Exception" with the exception form. */
  onStart: (checkId: string, action: 'image' | 'exception') => void
}

/** Step 2: the checks due on this machine, each with the two actions. */
export const MachineScreen: React.FC<Props> = ({ machine, refreshKey, onBack, onStart }) => {
  const [checks, setChecks] = useState<CheckSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const today = await getTodayChecks()
      setChecks(today.filter((c) => c.machineId === machine.id))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [machine.id])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useAutoRefresh(load)

  const onPullRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const due = checks?.filter((c) => c.canSubmit) ?? []
  const later = checks?.filter((c) => !c.canSubmit && c.status === 'PENDING') ?? []
  const done = checks?.filter((c) => !c.canSubmit && c.status !== 'PENDING').reverse() ?? []

  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="‹ Machines" onLeftPress={onBack} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} />}
      >
        <View className="pb-6 pt-5">
          <Text className="text-[14px] font-semibold uppercase tracking-[0.6px] text-ink-muted">{machine.code}</Text>
          <Text className="mt-1 text-[30px] font-bold tracking-[-0.5px] text-ink">{machine.name}</Text>
        </View>

        {checks === null && error ? (
          <ErrorState message={error} onRetry={load} />
        ) : checks === null ? (
          <Loading />
        ) : (
          <View className="gap-8">
            {due.length === 0 ? (
              <EmptyState
                title="No check due right now"
                message={later.length ? `Next check at ${formatTime(later[0].scheduledAt)}.` : 'No more checks on this machine today.'}
              />
            ) : (
              <View className="gap-4">
                {due.map((check) => (
                  <View key={check.id} className="rounded-2xl border border-due-line bg-surface p-4">
                    <Text className="text-[13px] font-semibold uppercase tracking-[0.5px] text-due">Due now</Text>
                    <Text className="mt-1 text-[20px] font-semibold text-ink">{check.activityName}</Text>
                    <Text className="mt-0.5 text-[15px] text-ink-muted">
                      Due {formatTime(check.scheduledAt)} · open until {formatTime(check.windowEndsAt)}
                    </Text>
                    <View className="mt-4 gap-3">
                      <Button label="Click Image" onPress={() => onStart(check.id, 'image')} />
                      <Button label="Exception" variant="warningOutline" onPress={() => onStart(check.id, 'exception')} />
                    </View>
                  </View>
                ))}
              </View>
            )}

            {later.length > 0 && (
              <View>
                <SectionHeader title="Later today" />
                <ListGroup>
                  {later.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ListGroup>
              </View>
            )}

            {done.length > 0 && (
              <View>
                <SectionHeader title="Earlier today" />
                <ListGroup>
                  {done.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ListGroup>
              </View>
            )}

            {error ? <Text className="px-4 text-[14px] text-failed">Could not refresh: {error}</Text> : null}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
