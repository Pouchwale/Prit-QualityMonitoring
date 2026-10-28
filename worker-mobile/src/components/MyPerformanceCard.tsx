import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { getMyPerformance } from '../services/api'
import { TODAY_RANGE } from '../utils/score'
import { MyPerformance } from '../types'
import { friendlyMessage } from '../utils/friendlyError'
import { Icon } from './ui/Icon'

/** Today only: the week is on "My week" and everything so far on "Overall score". */
const todayRange = TODAY_RANGE

/**
 * "My performance" on the worker's Profile: today's figures of this worker only, from the backend
 * (GET /api/worker/performance). The score is the backend's; nothing is calculated here.
 */
export const MyPerformanceCard: React.FC = () => {
  const [data, setData] = useState<MyPerformance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getMyPerformance(todayRange()))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-[17px] font-semibold text-ink">My performance</Text>
        <View className="rounded-lg bg-subtle px-2.5 py-1">
          <Text className="text-[13px] font-semibold text-ink">Today</Text>
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
              <Text className={`text-[34px] font-bold leading-[40px] ${data.score < 0 ? 'text-missed' : 'text-success'}`}>{data.score}%</Text>
            </View>
            <Text className="pb-1.5 text-right text-[13px] leading-[18px] text-ink-muted">
              {data.completionRate}% done
              {'\n'}
              {100 - data.completionRate}% missed
            </Text>
          </View>
          <View className="mt-3 flex-row rounded-xl bg-subtle">
            <Figure label="Assigned" value={data.assigned} />
            <Figure label="Completed" value={data.completed} />
            <Figure label="Exceptions" value={data.exceptions} />
            <Figure label="Missed" value={data.missed} last />
          </View>
          <Text className="mt-2 text-[13px] leading-[18px] text-ink-muted">
            0% is the best score: each missed check lowers it. Assigned are the checks whose time is over; exceptions count as done.
            {data.open > 0
              ? ` ${data.open} check${data.open === 1 ? ' is' : 's are'} still open and not counted yet: submit ${data.open === 1 ? 'it' : 'them'} on time to keep the score.`
              : ''}
          </Text>
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
