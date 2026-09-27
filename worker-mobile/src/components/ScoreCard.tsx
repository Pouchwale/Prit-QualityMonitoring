import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { getMyPerformance } from '../services/api'
import { SCORE_RANGE } from '../utils/score'
import { Icon } from './ui/Icon'

/**
 * The small "Score" card next to the heading on the machine list: the worker's own score, and
 * nothing else. It is **display only** — it is not a button and opens nothing.
 *
 * The number comes from the backend (GET /api/worker/performance), the same score the admin panel
 * shows; while it loads, or if it cannot be read, the card simply shows no number.
 */
export const ScoreCard: React.FC<{ refreshKey?: number }> = ({ refreshKey = 0 }) => {
  const [score, setScore] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    getMyPerformance(SCORE_RANGE())
      .then((p) => {
        if (alive) setScore(p.score)
      })
      .catch(() => {
        /* the card stays in place without the number */
      })
    return () => {
      alive = false
    }
  }, [refreshKey])

  return (
    <View
      className="ml-3 min-h-[64px] min-w-[76px] items-center justify-center rounded-2xl bg-surface px-3 py-2"
      accessible
      accessibilityLabel={score === null ? 'My score' : `My score: ${score} percent`}
    >
      <View className="flex-row items-center">
        <Icon name="trophy-outline" size={14} color="muted" />
        <Text className="ml-1 text-[13px] font-medium text-ink-muted">Score</Text>
      </View>
      <Text className="mt-0.5 text-[22px] font-bold leading-[26px] text-ink" numberOfLines={1}>
        {score === null ? '—' : score}
      </Text>
    </View>
  )
}
