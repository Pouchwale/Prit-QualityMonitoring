import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { useStaff } from '../nav'
import { useQuery } from '../useQuery'
import { addDaysKey, dateKey, formatKey } from '../format'
import { DataState, List, MiniStat, Notice, Row, Screen, Section, Segmented } from '../ui'

/** Worker performance for Managers and Admins. The backend calculates every score. */

interface WorkerPerformance {
  workerId: string
  workerName: string
  employeeId: string
  assigned: number
  completed: number
  missed: number
  missedChecks: number
  exceptions: number
  open: number
  score: number
  completionRate: number
}

interface PerformanceScope {
  departmentId: string | null
  departmentName: string | null
  restricted: boolean
  missingDepartment: boolean
}

interface PerformanceResult {
  scope: PerformanceScope
  penaltyPerMissed: number
  totals: { workers: number; assigned: number; completed: number; missed: number; score: number; completionRate: number }
  workers: WorkerPerformance[]
}

const PERIODS = [
  { label: 'Today', range: () => ({ from: dateKey(), to: dateKey() }) },
  { label: '7 days', range: () => ({ from: addDaysKey(dateKey(), -6), to: dateKey() }) },
  { label: '30 days', range: () => ({ from: addDaysKey(dateKey(), -29), to: dateKey() }) }
]

export const PerformanceScreen: React.FC = () => {
  useStaff()
  const [periodIndex, setPeriodIndex] = useState(1)
  const range = PERIODS[periodIndex].range()
  const api = useQuery<PerformanceResult>('/api/performance/workers', range)
  const data = api.data

  return (
    <Screen
      title="Worker Performance"
      subtitle={`${formatKey(range.from)} – ${formatKey(range.to)}${data?.scope?.restricted && data.scope.departmentName ? ` · ${data.scope.departmentName}` : ''}`}
      back
      onRefresh={api.reload}
      refreshing={api.loading}
    >
      <Segmented
        options={PERIODS.map((p, i) => ({ label: p.label, value: String(i) }))}
        value={String(periodIndex)}
        onChange={(v) => setPeriodIndex(Number(v))}
      />

      <DataState loading={api.loading} error={api.error} onRetry={api.reload} empty={data ? data.workers.length === 0 : false} emptyText="No checks were assigned in this period.">
        {data ? (
          <>
            <View className="flex-row gap-3">
              <MiniStat label="Assigned" value={data.totals.assigned} />
              <MiniStat label="Completed" value={data.totals.completed} tone="success" />
              <MiniStat label="Missed" value={data.totals.missed} tone={data.totals.missed ? 'missed' : 'neutral'} />
            </View>

            <Section title="By worker" detail={`Score = missed × ${data.penaltyPerMissed}`}>
              <List>
                {data.workers.map((w) => (
                  <Row
                    key={w.workerId}
                    title={w.workerName}
                    subtitle={`${w.assigned} assigned · ${w.completed} completed · ${w.missed} missed`}
                    detail={`${w.completionRate}% completed`}
                    right={
                      <Text className={`text-[20px] font-semibold ${w.score < 0 ? 'text-missed' : 'text-success'}`} accessibilityLabel={`Score ${w.score} percent`}>
                        {w.score}%
                      </Text>
                    }
                  />
                ))}
              </List>
            </Section>

            {data.scope?.missingDepartment ? (
              <Notice message="Your account has no department yet, so no workers are shown. Ask an Admin to set your department." />
            ) : data.scope?.restricted ? (
              <Notice message={`You see the ${data.scope.departmentName} department only. Workers of other departments are not included.`} />
            ) : null}
            <Notice message="The penalty per missed check is set by an Admin in the admin panel (Worker Performance → Score settings)." />
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

export const PERFORMANCE_SCREENS = {
  performance: PerformanceScreen
}
