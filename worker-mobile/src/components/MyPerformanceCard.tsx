import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { getMyPerformance } from '../services/api'
import { MyPerformance } from '../types'
import { dateKey } from '../utils/dates'
import { friendlyMessage } from '../utils/friendlyError'
import { Icon } from './ui/Icon'

const PERIODS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: 'week', label: '7 days', days: 6 },
  { key: 'month', label: '30 days', days: 29 }
] as const

const rangeFor = (days: number) => {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - days)
  return { from: dateKey(from), to: dateKey(to) }
}

/**
 * "My performance" on the worker's Profile: only this worker's own figures, from the backend
 * (GET /api/worker/performance). The score is the backend's; nothing is calculated here.
 */
export const MyPerformanceCard: React.FC = () => {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[1])
  const [data, setData] = useState<MyPerformance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getMyPerformance(rangeFor(period.days)))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    load()
  }, [load])

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-[17px] font-semibold text-ink">My performance</Text>
        <View className="flex-row rounded-lg bg-subtle p-0.5">
          {PERIODS.map((p) => (
            <Pressable
              key={p.key}
              onPress={() => setPeriod(p)}
              accessibilityRole="button"
              accessibilityState={{ selected: p.key === period.key }}
              accessibilityLabel={`Show ${p.label}`}
              className={`min-h-[32px] justify-center rounded-md px-2.5 ${p.key === period.key ? 'bg-surface' : ''}`}
            >
              <Text className={`text-[13px] ${p.key === period.key ? 'font-semibold text-ink' : 'text-ink-muted'}`}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading && !data ? (
        <View className="items-center py-6">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="mt-3 flex-row items-start">
          <Icon name="cloud-offline-outline" size={18} color="muted" />
          <Text className="ml-2 flex-1 text-[14px] leading-[19px] text-ink-muted">{error}</Text>
        </View>
      ) : data ? (
        <>
          <View className="mt-3 flex-row items-end justify-between">
            <View>
              <Text className="text-[13px] text-ink-muted">My score</Text>
              <Text className={`text-[34px] font-bold leading-[40px] ${data.score < 0 ? 'text-missed' : 'text-success'}`}>{data.score}</Text>
            </View>
            <Text className="pb-1.5 text-right text-[13px] leading-[18px] text-ink-muted">
              {data.missed} missed × {data.penaltyPerMissed}
              {'\n'}
              {data.completionRate}% completed
            </Text>
          </View>
          <View className="mt-3 flex-row rounded-xl bg-subtle">
            <Figure label="Assigned" value={data.assigned} />
            <Figure label="Completed" value={data.completed} />
            <Figure label="Missed" value={data.missed} last />
          </View>
          {data.open > 0 ? (
            <Text className="mt-2 text-[13px] leading-[18px] text-ink-muted">
              {data.open} check{data.open === 1 ? ' is' : 's are'} still open in this period; submitting {data.open === 1 ? 'it' : 'them'} improves the score.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  )
}

const Figure: React.FC<{ label: string; value: number; last?: boolean }> = ({ label, value, last }) => (
  <View className={`flex-1 items-center py-2.5 ${last ? '' : 'border-r border-line'}`}>
    <Text className="text-[20px] font-semibold text-ink">{value}</Text>
    <Text className="text-[13px] text-ink-muted">{label}</Text>
  </View>
)
