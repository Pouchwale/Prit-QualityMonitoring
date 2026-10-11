import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { getMyWeek } from '../services/api'
import type { MyWeek, WeekDayScore } from '../types'
import { dateKey } from '../utils/dates'
import { friendlyMessage } from '../utils/friendlyError'
import { Icon } from './ui/Icon'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "2026-10-05" + n days, as YYYY-MM-DD (dates are plain calendar days here). */
const shiftKey = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + days))
}
const shortDate = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`

/** Green for 0%, orange down to −20%, red below: the same colours as the admin report. */
const tone = (score: number) => (score === 0 ? 'text-success' : score >= -20 ? 'text-exception' : 'text-missed')

/**
 * "My week" on the worker's Profile: this worker's own score for each day, Monday to Saturday, and
 * for the whole week. Only their own figures (the backend answers for the signed-in worker only);
 * shown on screen only, with no download.
 */
export const MyWeekCard: React.FC = () => {
  const [week, setWeek] = useState<string>(dateKey(new Date()))
  const [data, setData] = useState<MyWeek | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getMyWeek(week))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [week])

  useEffect(() => {
    load()
  }, [load])

  const today = dateKey(new Date())
  const isThisWeek = data ? today >= data.dates[0] && today <= shiftKey(data.dates[0], 6) : true
  const go = (days: number) => data && setWeek(shiftKey(data.dates[0], days))

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-[17px] font-semibold text-ink">My week</Text>
        <View className="flex-row items-center">
          <Pressable onPress={() => go(-7)} accessibilityRole="button" accessibilityLabel="Previous week" className="min-h-[36px] min-w-[36px] items-center justify-center">
            <Icon name="chevron-back" size={18} color="secondary" />
          </Pressable>
          <Text className="text-[13px] font-medium text-ink-secondary">
            {data ? `${shortDate(data.dates[0])} – ${shortDate(data.dates[5])}` : '…'}
          </Text>
          <Pressable
            onPress={() => go(7)}
            disabled={isThisWeek}
            accessibilityRole="button"
            accessibilityLabel="Next week"
            accessibilityState={{ disabled: isThisWeek }}
            className={`min-h-[36px] min-w-[36px] items-center justify-center ${isThisWeek ? 'opacity-30' : ''}`}
          >
            <Icon name="chevron-forward" size={18} color="secondary" />
          </Pressable>
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
          <View className="mt-3 overflow-hidden rounded-xl bg-subtle">
            {data.dates.map((d, i) => (
              <DayRow key={d} label={`${DAY_NAMES[i]} ${shortDate(d)}`} today={d === today} score={data.days[i]} last={i === 5} />
            ))}
          </View>
          <View className="mt-3 flex-row items-end justify-between">
            <View>
              <Text className="text-[13px] text-ink-muted">Week score</Text>
              {data.week?.score != null ? (
                <Text className={`text-[30px] font-bold leading-[36px] ${tone(data.week.score)}`}>{data.week.score}%</Text>
              ) : (
                <Text className="text-[30px] font-bold leading-[36px] text-ink-faint">—</Text>
              )}
            </View>
            {data.week && data.week.assigned > 0 ? (
              <Text className="pb-1.5 text-right text-[13px] leading-[18px] text-ink-muted">
                {data.week.done} of {data.week.assigned} done
                {'\n'}
                {data.week.missed} missed
              </Text>
            ) : null}
          </View>
          <Text className="mt-2 text-[13px] leading-[18px] text-ink-muted">
            0% means every check was done; 8 of 10 done shows −20%. Exceptions count as done; days with no checks show —.
          </Text>
        </>
      ) : null}
    </View>
  )
}

const DayRow: React.FC<{ label: string; today: boolean; score: WeekDayScore | undefined; last: boolean }> = ({ label, today, score, last }) => (
  <View className={`min-h-[44px] flex-row items-center px-3 ${last ? '' : 'border-b border-line'} ${today ? 'bg-accent-soft' : ''}`}>
    <Text className={`flex-1 text-[15px] ${today ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
      {label}
      {today ? '  · today' : ''}
    </Text>
    {score?.score != null ? (
      <>
        <Text className="mr-3 text-[13px] text-ink-muted">
          {score.done}/{score.assigned}
        </Text>
        <Text className={`w-[56px] text-right text-[16px] font-bold ${tone(score.score)}`}>{score.score}%</Text>
      </>
    ) : (
      <Text className="w-[56px] text-right text-[16px] text-ink-faint">—</Text>
    )}
  </View>
)
