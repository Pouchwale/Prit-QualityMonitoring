import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { useStaff } from '../nav'
import { useQuery } from '../useQuery'
import { addDaysKey, dateKey, formatKey } from '../format'
import { Chips, DataState, DateField, Input, List, MiniStat, Notice, Row, Screen, Section, SelectField, SmallButton } from '../ui'

/**
 * Worker performance for Managers and Admins: the same filters and figures as the web panel's
 * Worker Performance page (admin-web/src/pages/admin/PerformancePage.tsx). The backend calculates
 * every score (GET /api/performance/workers); the filter lists come from
 * GET /api/performance/filter-values, which gives a Manager only their own department.
 */

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
  totals: { workers: number; assigned: number; completed: number; missed: number; score: number; completionRate: number }
  workers: WorkerPerformance[]
}

interface PerformanceFilterValues {
  machines: { id: string; name: string }[]
  shifts: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  workers: { id: string; name: string; employeeId: string; departmentId: string | null }[]
  scope: PerformanceScope
}

const PRESETS = [
  { label: 'Today', from: () => dateKey(), to: () => dateKey() },
  { label: 'Last 7 days', from: () => addDaysKey(dateKey(), -6), to: () => dateKey() },
  { label: 'Last 30 days', from: () => addDaysKey(dateKey(), -29), to: () => dateKey() }
]

export const PerformanceScreen: React.FC = () => {
  useStaff()
  const [from, setFrom] = useState(() => addDaysKey(dateKey(), -6))
  const [to, setTo] = useState(dateKey)
  const [workerId, setWorkerId] = useState('')
  const [machineId, setMachineId] = useState('')
  const [shiftId, setShiftId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [jobSearch, setJobSearch] = useState('')

  const api = useQuery<PerformanceResult>('/api/performance/workers', { from, to, workerId, machineId, shiftId, jobNo, departmentId })
  const filters = useQuery<PerformanceFilterValues>('/api/performance/filter-values')
  const data = api.data
  const scope = data?.scope ?? filters.data?.scope
  const preset = PRESETS.findIndex((p) => p.from() === from && p.to() === to)

  const reset = () => {
    setFrom(addDaysKey(dateKey(), -6))
    setTo(dateKey())
    setWorkerId('')
    setMachineId('')
    setShiftId('')
    setDepartmentId('')
    setJobNo('')
    setJobSearch('')
  }

  return (
    <Screen
      title="Worker Performance"
      subtitle={`${formatKey(from)} – ${formatKey(to)}${scope?.restricted && scope.departmentName ? ` · ${scope.departmentName}` : ''}`}
      back
      onRefresh={api.reload}
      refreshing={api.loading}
    >
      {scope?.missingDepartment ? (
        <Notice message="Your account has no department yet, so no workers are shown. Ask an Admin to set your department." />
      ) : scope?.restricted ? (
        <Notice message={`You see the ${scope.departmentName} department only. Workers of other departments are not included.`} />
      ) : null}

      <Section title="Filters">
        <View className="gap-3">
          <Chips
            options={PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
            value={preset >= 0 ? String(preset) : ''}
            onChange={(v) => {
              const p = PRESETS[Number(v)]
              setFrom(p.from())
              setTo(p.to())
            }}
          />
          <View className="flex-row gap-3">
            <View className="flex-1">
              <DateField
                label="From"
                value={from}
                onChange={(v) => {
                  if (!v) return
                  setFrom(v)
                  if (v > to) setTo(v)
                }}
              />
            </View>
            <View className="flex-1">
              <DateField
                label="To"
                value={to}
                onChange={(v) => {
                  if (!v) return
                  setTo(v)
                  if (v < from) setFrom(v)
                }}
              />
            </View>
          </View>
          <SelectField
            label="Department"
            value={scope?.restricted ? (scope.departmentId ?? '') : departmentId}
            emptyLabel={scope?.restricted ? undefined : 'All departments'}
            disabled={scope?.restricted}
            hint={scope?.restricted ? 'You see your own department only' : null}
            options={(filters.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
            onChange={setDepartmentId}
          />
          <SelectField
            label="Worker"
            value={workerId}
            emptyLabel="All workers"
            options={(filters.data?.workers ?? []).map((w) => ({ value: w.id, label: w.name, detail: w.employeeId }))}
            onChange={setWorkerId}
          />
          <SelectField label="Machine" value={machineId} emptyLabel="All machines" options={(filters.data?.machines ?? []).map((m) => ({ value: m.id, label: m.name }))} onChange={setMachineId} />
          <SelectField label="Shift" value={shiftId} emptyLabel="All shifts" options={(filters.data?.shifts ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={setShiftId} />
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <Input label="PO No." value={jobSearch} onChangeText={setJobSearch} placeholder="e.g. J-4417" autoCapitalize="characters" maxLength={60} />
            </View>
            <SmallButton label="Search" icon="search-outline" onPress={() => setJobNo(jobSearch.trim())} />
          </View>
          <SmallButton label="Reset filters" onPress={reset} className="self-start" />
        </View>
      </Section>

      <DataState loading={api.loading} error={api.error} onRetry={api.reload} empty={data ? data.workers.length === 0 : false} emptyText="No checks were assigned in this period.">
        {data ? (
          <>
            <View className="flex-row flex-wrap gap-3">
              <MiniStat label="Workers" value={data.totals.workers} />
              <MiniStat label="Assigned" value={data.totals.assigned} />
              <MiniStat label="Completed" value={data.totals.completed} tone="success" />
              <MiniStat label="Missed" value={data.totals.missed} tone={data.totals.missed ? 'missed' : 'neutral'} />
              <MiniStat label="Total score" value={`${data.totals.score}%`} tone={data.totals.score < 0 ? 'missed' : 'success'} />
            </View>

            <Section
              title="By worker"
              detail="Score = completion − 100: the share of a worker's checks still not done, as a negative percentage. Everything done is 0%; 80 of 100 done is −20%. Missed = assigned − completed."
            >
              <List>
                {data.workers.map((w) => (
                  <Row
                    key={w.workerId}
                    title={w.workerName}
                    subtitle={`${w.employeeId} · ${w.assigned} assigned · ${w.completed} completed · ${w.missed} missed`}
                    detail={`${w.completionRate}% completed · of which missed ${w.missedChecks} / exception ${w.exceptions} / open ${w.open}`}
                    detailLines={2}
                    right={
                      <Text className={`text-[20px] font-semibold ${w.score < 0 ? 'text-missed' : 'text-success'}`} accessibilityLabel={`Score ${w.score} percent`}>
                        {w.score}%
                      </Text>
                    }
                  />
                ))}
              </List>
            </Section>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

export const PERFORMANCE_SCREENS = {
  performance: PerformanceScreen
}
