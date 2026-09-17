import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, Image } from 'react-native'
import { VideoView, useVideoPlayer } from 'expo-video'
import { cssInterop } from 'nativewind'
import { ApiError, fileUrl, getCheckRecord } from '../services/api'
import { CheckRecord, MediaFile, SubmittedValue } from '../types'
import { formatDuration } from '../utils/format'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { StatusLabel } from '../components/ui/StatusLabel'
import { ErrorState, Loading } from '../components/ui/LoadState'

cssInterop(VideoView, { className: 'style' })

interface Props {
  checkId: string
  onClose: () => void
}

const RESULT_STYLE: Record<SubmittedValue['result'], string> = {
  PASS: 'text-success',
  FAIL: 'text-failed',
  NA: 'text-ink-muted'
}

const RESULT_LABEL: Record<SubmittedValue['result'], string> = {
  PASS: 'Pass',
  FAIL: 'Out of range',
  NA: ''
}

const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <View className="min-h-[56px] flex-row items-center justify-between px-4 py-3">
    <Text className="text-[16px] text-ink-muted">{label}</Text>
    <View className="ml-4 flex-1 items-end">
      {typeof value === 'string' ? (
        <Text className="text-right text-[16px] font-medium text-ink">{value || '—'}</Text>
      ) : (
        value
      )}
    </View>
  </View>
)

const ValueRow: React.FC<{ value: SubmittedValue }> = ({ value }) => (
  <View className="px-4 py-3.5">
    <View className="flex-row items-start justify-between">
      <Text className="flex-1 pr-3 text-[16px] font-medium text-ink">{value.parameterName}</Text>
      <Text className="text-[17px] font-semibold text-ink">
        {value.value ?? '—'}
        {value.unit ? ` ${value.unit}` : ''}
      </Text>
    </View>
    <View className="mt-1 flex-row items-center justify-between">
      <Text className="flex-1 pr-3 text-[14px] text-ink-muted" numberOfLines={1}>
        {value.rule ?? ''}
      </Text>
      {value.result !== 'NA' ? (
        <Text className={`text-[14px] font-semibold ${RESULT_STYLE[value.result]}`}>{RESULT_LABEL[value.result]}</Text>
      ) : null}
    </View>
  </View>
)

const VideoBlock: React.FC<{ uri: string }> = ({ uri }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false
  })
  return <VideoView player={player} nativeControls contentFit="contain" className="h-56 w-full bg-black" />
}

const MediaBlock: React.FC<{ media: MediaFile[]; title: string }> = ({ media, title }) => {
  if (media.length === 0) return null
  return (
    <View>
      <SectionHeader title={title} />
      <View className="gap-3">
        {media.map((m) =>
          m.kind === 'PHOTO' ? (
            <Image
              key={m.id}
              source={{ uri: fileUrl(m.url) }}
              className="h-72 w-full rounded-xl border border-line bg-subtle"
              resizeMode="cover"
            />
          ) : (
            <View key={m.id} className="overflow-hidden rounded-xl border border-line">
              <VideoBlock uri={fileUrl(m.url)} />
              {m.durationSeconds != null ? (
                <Text className="bg-surface px-4 py-2 text-[14px] text-ink-muted">
                  Video · {formatDuration(m.durationSeconds)}
                </Text>
              ) : null}
            </View>
          )
        )}
      </View>
    </View>
  )
}

const EXCEPTION_STATUS: Record<string, string> = {
  UNDER_REVIEW: 'Under review',
  ACKNOWLEDGED: 'Seen by supervisor',
  ACTION_TAKEN: 'Action taken',
  RESOLVED: 'Resolved'
}

/** One submitted record: photo, video, all values and details. */
export const HistoryDetailScreen: React.FC<Props> = ({ checkId, onClose }) => {
  const [record, setRecord] = useState<CheckRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRecord(await getCheckRecord(checkId))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [checkId])

  useEffect(() => {
    load()
  }, [load])

  const formatWhen = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '—'

  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="‹ History" onLeftPress={onClose} title="Record" />

      {!record ? (
        <View className="flex-1 px-5 pt-6">{error ? <ErrorState message={error} onRetry={load} /> : <Loading />}</View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10">
          <View className="pb-6 pt-5">
            <Text className="text-[14px] font-semibold uppercase tracking-[0.6px] text-ink-muted">{record.code}</Text>
            <Text className="mt-1 text-[28px] font-bold tracking-[-0.5px] text-ink">{record.machineName}</Text>
            <Text className="mt-1 text-[17px] text-ink-secondary">{record.activityName}</Text>
            <View className="mt-2">
              <StatusLabel status={record.status} />
            </View>
          </View>

          <View className="gap-7">
            <MediaBlock media={record.media} title="Photo & video" />
            {record.exception ? <MediaBlock media={record.exception.media} title="Exception photo" /> : null}

            <View>
              <SectionHeader title="Details" />
              <ListGroup>
                <DetailRow label="Submitted" value={formatWhen(record.submittedAt)} />
                <DetailRow label="Scheduled" value={formatWhen(record.scheduledAt)} />
                <DetailRow label="Machine" value={`${record.machineName} (${record.machineCode})`} />
                <DetailRow label="Department" value={record.departmentName ?? '—'} />
                {record.shiftName ? <DetailRow label="Shift" value={record.shiftName} /> : null}
                {record.jobNo ? <DetailRow label="Job No." value={record.jobNo} /> : null}
                <DetailRow label="Status" value={<StatusLabel status={record.status} />} />
              </ListGroup>
            </View>

            {record.exception ? (
              <View>
                <SectionHeader title="Exception" />
                <ListGroup>
                  <DetailRow label="Reason" value={record.exception.reason} />
                  {record.exception.remark ? <DetailRow label="Remark" value={record.exception.remark} /> : null}
                  <DetailRow label="Review" value={EXCEPTION_STATUS[record.exception.status] ?? record.exception.status} />
                  {record.exception.resolutionNotes ? (
                    <DetailRow label="Supervisor note" value={record.exception.resolutionNotes} />
                  ) : null}
                </ListGroup>
              </View>
            ) : null}

            {record.values.length > 0 ? (
              <View>
                <SectionHeader title="Readings" detail={`${record.values.length}`} />
                <ListGroup>
                  {record.values.map((v, index) => (
                    <ValueRow key={`${v.parameterId ?? v.parameterName}-${index}`} value={v} />
                  ))}
                </ListGroup>
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  )
}
