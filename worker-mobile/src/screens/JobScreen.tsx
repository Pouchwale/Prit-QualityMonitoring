import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl } from 'react-native'
import { ApiError, getJob } from '../services/api'
import { CheckKind, JobDetail } from '../types'
import { formatDateTime } from '../utils/datetime'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { CheckRow } from '../components/ui/CheckRow'
import { StatusLabel, hasStatusLabel } from '../components/ui/StatusLabel'
import { ErrorState, Loading } from '../components/ui/LoadState'

export const KIND_LABEL: Record<CheckKind, string> = {
  SCHEDULED: 'Scheduled check',
  JOB_START: 'Job Start check',
  JOB_INTERVAL: 'Scheduled job check',
  JOB_END: 'Job End check'
}

const STATUS_TEXT: Record<string, string> = {
  PLANNED: 'Planned',
  STARTING: 'Waiting for the Job Start check',
  ACTIVE: 'Running',
  ENDING: 'Waiting for the Job End check',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
}

const readingText = (value: string | null) => (value && /^(PASS|FAIL|YES|NO)$/.test(value) ? value[0] + value.slice(1).toLowerCase() : value ?? '—')

interface Props {
  jobId: string
  onBack: () => void
  onOpenCheck: (checkId: string) => void
}

/** A job: details, handovers, the checks still to do and every check done in it so far. */
export const JobScreen: React.FC<Props> = ({ jobId, onBack, onOpenCheck }) => {
  const [data, setData] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getJob(jobId))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [jobId])

  useEffect(() => {
    load()
  }, [load])

  const job = data?.job
  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="Back" onLeftPress={onBack} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-12"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
              setRefreshing(false)
            }}
          />
        }
      >
        {!data && error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data || !job ? (
          <Loading />
        ) : (
          <View className="gap-8">
            <View className="pt-4">
              <Text className="text-[15px] font-medium text-ink-muted">
                {data.machine ? `${data.machine.name} · ${data.machine.code}` : ''}
              </Text>
              <Text className="mt-0.5 text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
                Job No. {job.jobNo}
              </Text>
              <View className="mt-3 gap-1 rounded-2xl bg-surface p-4">
                <Text className="text-[16px] text-ink">
                  <Text className="text-ink-muted">Status </Text>
                  {STATUS_TEXT[job.status ?? 'ACTIVE']}
                </Text>
                {job.itemCode ? (
                  <Text className="text-[16px] text-ink">
                    <Text className="text-ink-muted">Item Code </Text>
                    {job.itemCode}
                  </Text>
                ) : null}
                <Text className="text-[16px] text-ink">
                  <Text className="text-ink-muted">Worker now </Text>
                  {job.assignedWorkerName ?? '—'}
                </Text>
                {job.startedAt ? (
                  <Text className="text-[16px] text-ink">
                    <Text className="text-ink-muted">Started </Text>
                    {formatDateTime(job.startedAt)}
                    {job.startedByName ? ` by ${job.startedByName}` : ''}
                  </Text>
                ) : null}
                {job.endedAt ? (
                  <Text className="text-[16px] text-ink">
                    <Text className="text-ink-muted">Ended </Text>
                    {formatDateTime(job.endedAt)}
                  </Text>
                ) : null}
              </View>
            </View>

            {data.open.length > 0 ? (
              <View>
                <SectionHeader title="To do" />
                <ListGroup>
                  {data.open.map((c) => (
                    <CheckRow key={c.id} check={c} detail={KIND_LABEL[c.kind ?? 'SCHEDULED']} onPress={c.canSubmit ? () => onOpenCheck(c.id) : undefined} />
                  ))}
                </ListGroup>
              </View>
            ) : null}

            {data.handovers.length > 0 ? (
              <View>
                <SectionHeader title="Handovers" />
                <View className="gap-2">
                  {data.handovers.map((h) => (
                    <View key={h.id} className="rounded-2xl bg-surface p-4">
                      <Text className="text-[16px] font-semibold text-ink">
                        {h.fromName ?? '—'} → {h.toName ?? '—'}
                      </Text>
                      <Text className="mt-0.5 text-[14px] text-ink-muted">
                        {formatDateTime(h.at)}
                        {h.shiftName ? ` · ${h.shiftName}` : ''}
                      </Text>
                      {h.note ? <Text className="mt-1 text-[15px] text-ink-secondary">{h.note}</Text> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View>
              <SectionHeader title="Checks done" />
              {data.history.length === 0 ? (
                <Text className="px-4 text-[15px] text-ink-muted">No checks yet.</Text>
              ) : (
                <View className="gap-2">
                  {data.history.map((c) => (
                    <View key={c.id} className="rounded-2xl bg-surface p-4">
                      <View className="flex-row items-center">
                        <Text className="flex-1 text-[16px] font-semibold text-ink">{KIND_LABEL[c.kind ?? 'SCHEDULED']}</Text>
                        {hasStatusLabel(c.status) ? <StatusLabel status={c.status} /> : null}
                      </View>
                      <Text className="mt-0.5 text-[14px] text-ink-muted">
                        {formatDateTime(c.submittedAt ?? c.scheduledAt)}
                        {c.workerName ? ` · ${c.workerName}` : ''}
                      </Text>
                      {c.values.length > 0 ? (
                        <View className="mt-2 gap-0.5">
                          {c.values.map((v, i) => (
                            <Text key={i} className={`text-[15px] ${v.result === 'FAIL' ? 'text-missed' : 'text-ink-secondary'}`}>
                              {v.parameterName}: {v.notApplicable ? `Not applicable${v.naReason ? ` (${v.naReason})` : ''}` : `${readingText(v.value)}${v.unit ? ` ${v.unit}` : ''}`}
                              {v.result === 'FAIL' ? ' · outside limits' : ''}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                      {c.exception ? (
                        <Text className="mt-2 text-[15px] text-exception">
                          Exception: {c.exception.reason}
                          {c.exception.remark ? ` — ${c.exception.remark}` : ''}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
