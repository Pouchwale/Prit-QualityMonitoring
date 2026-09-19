import React, { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { AssignedMachine, Job, JobCheck, JobPlan } from '../types'
import { formatTime } from '../utils/format'
import { formatDate } from '../utils/datetime'
import { Button } from './ui/Button'
import { TextField } from './ui/TextField'
import { FieldLabel } from './ui/FieldLabel'
import { Icon } from './ui/Icon'

const every = (minutes: number) => (minutes % 60 === 0 ? (minutes === 60 ? 'Every 1 hour' : `Every ${minutes / 60} hours`) : `Every ${minutes} min`)

/** What the job-based check types ask at start, at each interval and at end. */
export const JobPlanList: React.FC<{ plan: JobPlan[] }> = ({ plan }) => {
  const lines: { label: string; names: string[] }[] = []
  for (const type of plan) {
    if (type.start.length) lines.push({ label: 'Job start', names: type.start })
    for (const i of type.intervals) lines.push({ label: every(i.minutes), names: i.parameters })
    if (type.end.length) lines.push({ label: 'Job end', names: type.end })
  }
  if (lines.length === 0) return null
  return (
    <View className="mt-3 gap-1.5 rounded-xl bg-subtle px-3 py-2.5">
      {lines.map((l, i) => (
        <View key={i} className="flex-row">
          <Text className="w-[108px] text-[14px] font-semibold text-ink-secondary">{l.label}</Text>
          <Text className="flex-1 text-[14px] text-ink-muted">{l.names.join(', ')}</Text>
        </View>
      ))}
    </View>
  )
}

interface Props {
  machine: AssignedMachine
  meId: string
  busy: string | null
  onStartPlanned: (job: Job) => void
  onStartNew: (jobNo: string, itemCode: string) => void
  onOpenCheck: (checkId: string) => void
  onEndJob: () => void
  onHandover: () => void
  onOpenJob: () => void
}

/**
 * The machine's job: start one (planned or new), the Job Start check, the running job with its
 * next check, End Job and Handover, and the Job End check.
 */
export const JobCard: React.FC<Props> = ({ machine, meId, busy, onStartPlanned, onStartNew, onOpenCheck, onEndJob, onHandover, onOpenJob }) => {
  const job = machine.runningJob
  const [itemCode, setItemCode] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [jobError, setJobError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const checks: JobCheck[] = machine.jobChecks ?? []
  const planned = machine.plannedJobs ?? []
  const plan = machine.jobPlan ?? []

  if (!job) {
    const newForm = (
      <View className="mt-4">
        <FieldLabel label="Item Code" />
        <TextField placeholder="Enter Item Code" value={itemCode} onChangeText={setItemCode} autoCapitalize="characters" autoCorrect={false} maxLength={60} accessibilityLabel="Item Code" />
        <View className="h-4" />
        <FieldLabel label="Job No." required />
        <TextField
          placeholder="Enter Job No."
          value={jobNo}
          invalid={!!jobError}
          onChangeText={(text) => {
            setJobNo(text)
            setJobError(null)
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={60}
          accessibilityLabel="Job No."
        />
        {jobError ? <Text className="mt-2 text-[15px] font-medium text-missed">{jobError}</Text> : null}
        <Button
          label="Start Job"
          icon="play-outline"
          loading={busy === 'job'}
          onPress={() => {
            if (!jobNo.trim()) return setJobError('Enter the Job No.')
            onStartNew(jobNo.trim(), itemCode.trim())
          }}
          className="mt-4"
        />
      </View>
    )
    return (
      <View className="rounded-2xl bg-surface p-4">
        <Text className="text-[17px] font-semibold text-ink">No job running</Text>
        <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-muted">
          {plan.length ? 'Start a job: the Job Start check comes first, then the scheduled checks.' : 'Job-based checks start once you begin a job on this machine.'}
        </Text>
        <JobPlanList plan={plan} />
        {planned.length > 0 ? (
          <View className="mt-4 gap-2.5">
            <Text className="text-[15px] font-semibold text-ink-muted">Assigned jobs</Text>
            {planned.map((p) => (
              <View key={p.id} className="rounded-xl border border-line p-3">
                <Text className="text-[17px] font-semibold text-ink">Job No. {p.jobNo}</Text>
                <Text className="mt-0.5 text-[15px] text-ink-secondary">
                  {[p.itemCode ? `Item Code ${p.itemCode}` : null, p.plannedFor ? `Planned for ${formatDate(p.plannedFor)}` : null].filter(Boolean).join(' · ') || 'Planned job'}
                </Text>
                {p.note ? <Text className="mt-0.5 text-[14px] text-ink-muted">{p.note}</Text> : null}
                <Button
                  label="Start Job"
                  icon="play-outline"
                  size="compact"
                  accessibilityLabel={`Start Job ${p.jobNo}`}
                  loading={busy === `plan:${p.id}`}
                  onPress={() => onStartPlanned(p)}
                  className="mt-3"
                />
              </View>
            ))}
            {showNew ? (
              newForm
            ) : (
              <Pressable onPress={() => setShowNew(true)} accessibilityRole="button" className="h-11 justify-center self-start active:opacity-50">
                <Text className="text-[16px] font-semibold text-accent">Start a different job</Text>
              </Pressable>
            )}
          </View>
        ) : (
          newForm
        )}
      </View>
    )
  }

  const mine = !job.assignedWorkerId || job.assignedWorkerId === meId
  const startCheck = checks.find((c) => c.kind === 'JOB_START')
  const endCheck = checks.find((c) => c.kind === 'JOB_END')
  const nextCheck = checks.find((c) => c.kind === 'JOB_INTERVAL')
  const status = job.status ?? 'ACTIVE'
  const head =
    status === 'STARTING' ? { text: 'Job Start check needed', tone: 'text-due', dot: 'bg-due' }
    : status === 'ENDING' ? { text: 'Job End check needed', tone: 'text-due', dot: 'bg-due' }
    : { text: 'Job running', tone: 'text-success', dot: 'bg-success' }

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="flex-row items-center">
        <View className={`mr-2 h-2 w-2 rounded-full ${head.dot}`} />
        <Text className={`flex-1 text-[15px] font-semibold ${head.tone}`}>{head.text}</Text>
        {job.startedAt ? <Text className="text-[15px] text-ink-muted">Started {formatTime(job.startedAt)}</Text> : null}
      </View>
      <Text className="mt-1.5 text-[20px] font-semibold text-ink">Job No. {job.jobNo}</Text>
      {job.itemCode ? <Text className="mt-0.5 text-[15px] text-ink-secondary">Item Code {job.itemCode}</Text> : null}
      {!mine ? (
        <View className="mt-3 flex-row items-start border-t border-line pt-3">
          <Icon name="person-outline" size={18} color="muted" />
          <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-muted">
            This job is with {job.assignedWorkerName ?? 'another worker'}. They can hand it over to you.
          </Text>
        </View>
      ) : status === 'STARTING' ? (
        <View className="mt-4">
          <Text className="text-[15px] leading-[20px] text-ink-secondary">
            Check the start parameters{startCheck?.parameterNames.length ? ` (${startCheck.parameterNames.join(', ')})` : ''}. The scheduled checks begin once you submit.
          </Text>
          {startCheck ? <Button label="Job Start check" icon="clipboard-outline" onPress={() => onOpenCheck(startCheck.id)} className="mt-3" /> : null}
        </View>
      ) : status === 'ENDING' ? (
        <View className="mt-4">
          <Text className="text-[15px] leading-[20px] text-ink-secondary">
            Check the end parameters{endCheck?.parameterNames.length ? ` (${endCheck.parameterNames.join(', ')})` : ''}. The job is completed when you submit.
          </Text>
          {endCheck ? <Button label="Job End check" icon="clipboard-outline" onPress={() => onOpenCheck(endCheck.id)} className="mt-3" /> : null}
        </View>
      ) : (
        <View className="mt-3">
          {nextCheck ? (
            <View className="flex-row items-start rounded-xl bg-subtle px-3 py-2.5">
              <Icon name="time-outline" size={18} color={nextCheck.canSubmit ? 'due' : 'muted'} />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-secondary">
                {nextCheck.canSubmit ? 'Due now' : `Next check at ${formatTime(nextCheck.scheduledAt)}`}: {nextCheck.parameterNames.join(', ')}
              </Text>
            </View>
          ) : null}
          <View className="mt-4 flex-row gap-2.5">
            <View className="flex-1">
              <Button label="Handover" icon="swap-horizontal-outline" variant="secondary" size="compact" onPress={onHandover} accessibilityLabel="Handover Job" />
            </View>
            <View className="flex-1">
              <Button label="End Job" icon="stop-circle-outline" variant="secondary" size="compact" loading={busy === 'job'} onPress={onEndJob} />
            </View>
          </View>
        </View>
      )}
      <Pressable onPress={onOpenJob} accessibilityRole="button" accessibilityLabel={`Job details ${job.jobNo}`} className="mt-2 h-11 flex-row items-center self-start active:opacity-50">
        <Text className="text-[16px] font-semibold text-accent">Job details and history</Text>
        <Icon name="chevron-forward" size={16} color="accent" />
      </Pressable>
    </View>
  )
}
