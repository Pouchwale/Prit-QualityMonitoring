import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { getMyPerformance } from '../services/api'
import { MyPerformance } from '../types'
import { SCORE_RANGE } from '../utils/score'
import { friendlyMessage } from '../utils/friendlyError'
import { NavBar } from '../components/ui/NavBar'
import { ErrorState } from '../components/ui/LoadState'

/**
 * My Score: the worker's own score and nothing else.
 *
 * Not linked from anywhere at the moment: the Score card on the machine list only displays the
 * number. The screen is kept for when a way in is wanted again.
 *
 * The number is the backend's (GET /api/worker/performance) — the same one the admin panel
 * shows — so nothing is worked out on the phone.
 */
export const ScoreScreen: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [data, setData] = useState<MyPerformance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getMyPerformance(SCORE_RANGE()))
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
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="Back" onLeftPress={onBack} title="Score" />
      <View className="flex-1 items-center justify-center px-6">
        {loading ? (
          <ActivityIndicator />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : (
          <>
            <Text className="text-[17px] font-medium text-ink-secondary" accessibilityRole="header">
              My Score
            </Text>
            <Text
              className="mt-2 text-[80px] font-bold leading-[88px] tracking-[-1.5px] text-ink"
              accessibilityLabel={`My score: ${data?.score ?? 0} percent`}
              adjustsFontSizeToFit
              numberOfLines={1}
            >
              {data?.score ?? 0}%
            </Text>
          </>
        )}
      </View>
    </View>
  )
}
