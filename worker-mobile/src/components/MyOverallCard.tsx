import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { getMyOverall } from '../services/api'
import type { MyOverall } from '../types'
import { friendlyMessage } from '../utils/friendlyError'
import { Icon } from './ui/Icon'

const longDate = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`

/** Green for 0%, orange down to −20%, red below: the same colours as the admin report. */
const tone = (score: number) => (score === 0 ? 'text-success' : score >= -20 ? 'text-exception' : 'text-missed')

/**
 * "Overall score" on the worker's Profile: this worker's own score over every check from their first
 * one up to today. Only their own figures (the backend answers for the signed-in worker only).
 */
export const MyOverallCard: React.FC = () => {
  const [data, setData] = useState<MyOverall | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getMyOverall())
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const o = data?.overall
  const pct = o && o.assigned ? Math.round((o.done / o.assigned) * 100) : 0

  return (
    <View className="rounded-2xl bg-surface p-4">
      <Text className="text-[17px] font-semibold text-ink">Overall score</Text>
      <Text className="mt-0.5 text-[13px] text-ink-muted">
        {data?.since ? `Since ${longDate(data.since)} (your first check) up to today` : 'From your first check up to today'}
      </Text>

      {loading && !data ? (
        <View className="items-center py-6">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="mt-3 flex-row items-start">
          <Icon name="cloud-offline-outline" size={18} color="muted" />
          <Text className="ml-2 flex-1 text-[14px] leading-[19px] text-ink-muted">{error}</Text>
        </View>
      ) : o && o.score != null ? (
        <>
          <View className="mt-3 flex-row items-end justify-between">
            <Text className={`text-[34px] font-bold leading-[40px] ${tone(o.score)}`}>{o.score}%</Text>
            <Text className="pb-1.5 text-right text-[13px] leading-[18px] text-ink-muted">
              {o.done} of {o.assigned} done{'\n'}
              {pct}% completion
            </Text>
          </View>
          <View className="mt-2 h-2 overflow-hidden rounded-full bg-subtle">
            <View className={`h-2 rounded-full ${o.score === 0 ? 'bg-success' : o.score >= -20 ? 'bg-exception' : 'bg-missed'}`} style={{ width: `${pct}%` }} />
          </View>
          <View className="mt-3 flex-row overflow-hidden rounded-xl bg-subtle">
            <Figure label="Completed" value={o.completed} className="text-success" />
            <Figure label="Exceptions" value={o.exceptions} className="text-exception" divider />
            <Figure label="Missed" value={o.missed} className={o.missed ? 'text-missed' : 'text-ink'} divider />
          </View>
          <Text className="mt-2 text-[13px] leading-[18px] text-ink-muted">
            0% is the best score: each missed check lowers it.
            {o.pending ? ` ${o.pending} check${o.pending === 1 ? ' is' : 's are'} still open and not counted yet.` : ''}
          </Text>
        </>
      ) : (
        <Text className="mt-3 text-[14px] text-ink-muted">No checks counted yet.</Text>
      )}
    </View>
  )
}

const Figure: React.FC<{ label: string; value: number; className: string; divider?: boolean }> = ({ label, value, className, divider }) => (
  <View className={`flex-1 items-center py-2.5 ${divider ? 'border-l border-line' : ''}`}>
    <Text className={`text-[18px] font-bold ${className}`}>{value}</Text>
    <Text className="text-[12px] text-ink-muted">{label}</Text>
  </View>
)
