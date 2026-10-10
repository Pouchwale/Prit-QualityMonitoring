import React, { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { AssignedMachine, Job, JobCheck, JobPlanPreview } from '../types'
import { getJobPlan } from '../services/api'
import { formatTime } from '../utils/format'
import { formatDate } from '../utils/datetime'
import { friendlyMessage } from '../utils/friendlyError'
import { CheckPlan } from './CheckPlan'
import { Button } from './ui/Button'
import { TextField } from './ui/TextField'
import { FieldLabel } from './ui/FieldLabel'
import { Icon } from './ui/Icon'
import { itemCodeError as itemCodeFormatError } from '../utils/itemCode'

interface Props {
  machine: AssignedMachine
  meId: string
  busy: string | null
  /**
   * Start a planned job, or a new one with its PO No. and Item Code; resolves true when it started.
   * The server works out the job's department from the Item Code.
   */
  onStartPlanned: (job: Job) => Promise<boolean>
  onStartNew: (jobNo: string, itemCode: string) => Promise<boolean>
  onOpenCheck: (checkId: string) => void
  onEndJob: () => void
  onHandover: () => void
  onOpenJob: () => void
}

/** One labelled value of the current job. Display only. */
const JobFact: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone = 'text-ink' }) => (
  <View className="mb-2.5 w-1/2 pr-2" accessible accessibilityLabel={`${label} ${value}`}>
    <Text className="text-[13px] font-medium text-ink-muted">{label}</Text>
    <Text className={`mt-0.5 text-[17px] font-semibold ${tone}`} numberOfLines={2}>
      {value}
    </Text>
  </View>
)

/** "Start Pre-Start Checks" when the plan has any, otherwise the job starts at once: "Start Job". */
const startLabel = (preview: JobPlanPreview) => (preview.plan.beforeStart.length > 0 ? 'Start Pre-Start Checks' : 'Start Job')

/** The department the server found for the Item Code, and the job's check plan, before Start Job. */
const PlanPreview: React.FC<{ preview: JobPlanPreview }> = ({ preview }) => (
  <View className="mt-4">
    <View className="flex-row flex-wrap rounded-xl bg-subtle px-3 pt-2.5">
      <JobFact label="Item Code" value={preview.itemCode} />
      <JobFact label="Department" value={preview.department.name.toUpperCase()} />
    </View>
    <Text className="mb-3 mt-4 text-[17px] font-semibold text-ink" accessibilityRole="header">
      Job Check Plan
    </Text>
    <CheckPlan plan={preview.plan} status={null} />
    {preview.plan.beforeStart.length > 0 ? (
      <Text className="mt-3 text-[14px] leading-[19px] text-ink-muted">
        Do the pre-start checks first: the job starts once they are submitted, then the checks during the job follow their schedule.
      </Text>
    ) : null}
  </View>
)

/**
 * The machine's job: before it starts, its check plan for the department the Item Code names (from
 * the server: the department's check configuration), then the pre-start checks; the running job with
 * its plan (done, due and next), End Job and Handover, and the job end checks.
 */
export const JobCard: React.FC<Props> = ({ machine, meId, busy, onStartPlanned, onStartNew, onOpenCheck, onEndJob, onHandover, onOpenJob }) => {
  const job = machine.runningJob
  const [itemCode, setItemCode] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [itemCodeError, setItemCodeError] = useState<string | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  /** The check plan shown before Start Job: for the new job ("new") or a planned job (its id). */
  const [preview, setPreview] = useState<{ key: string; data: JobPlanPreview } | null>(null)
  const [planLoading, setPlanLoading] = useState<string | null>(null)
  const [planError, setPlanError] = useState<{ key: string; message: string } | null>(null)
  const checks: JobCheck[] = machine.jobChecks ?? []
  const planned = machine.plannedJobs ?? []

  if (!job) {
    /**
     * Loads the check plan from the server: the department of the Item Code and its checks. Nothing
     * is started or created. When the Item Code cannot be placed, the server's message is shown and
     * what was typed stays, so the worker only corrects it.
     */
    const loadPlan = async (key: string, request: Parameters<typeof getJobPlan>[1]) => {
      if (planLoading) return
      setPlanLoading(key)
      setPlanError(null)
      try {
        setPreview({ key, data: await getJobPlan(machine.id, request) })
      } catch (err) {
        setPreview(null)
        setPlanError({ key, message: friendlyMessage(err) })
      } finally {
        setPlanLoading(null)
      }
    }
    /** The Item Code (standard format) and the PO No. are both needed, for the plan and for Start Job. */
    const validNew = () => {
      const code = itemCode.trim().toUpperCase()
      const no = jobNo.trim()
      const codeError = code ? itemCodeFormatError(code) : 'Enter the Item Code.'
      setItemCodeError(codeError)
      setJobError(no ? null : 'Enter the PO No.')
      return !codeError && no ? { code, no } : null
    }
    const showPlan = () => {
      const valid = validNew()
      if (valid) loadPlan('new', { itemCode: valid.code })
    }
    /** Start Job for a new job, after its plan was shown. The server checks everything again. */
    const startNew = async () => {
      const valid = validNew()
      if (!valid) return
      if (await onStartNew(valid.no, valid.code)) {
        // Started: the next job begins with an empty form.
        setItemCode('')
        setJobNo('')
        setShowNew(false)
        setPreview(null)
      }
    }
    const newPreview = preview?.key === 'new' ? preview.data : null
    const newForm = (
      <View className="mt-4">
        <FieldLabel label="Item Code" required />
        <TextField
          placeholder="Enter Item Code"
          value={itemCode}
          invalid={!!itemCodeError}
          onChangeText={(text) => {
            setItemCode(text)
            setItemCodeError(null)
            // Another Item Code may be another department: its plan is loaded again.
            if (preview?.key === 'new') setPreview(null)
            if (planError?.key === 'new') setPlanError(null)
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={60}
          accessibilityLabel="Item Code"
        />
        {itemCodeError ? <Text className="mt-2 text-[15px] font-medium text-missed">{itemCodeError}</Text> : null}
        <View className="h-4" />
        <FieldLabel label="PO No." required />
        <TextField
          placeholder="Enter PO No."
          value={jobNo}
          invalid={!!jobError}
          onChangeText={(text) => {
            setJobNo(text)
            setJobError(null)
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={60}
          accessibilityLabel="PO No."
        />
        {jobError ? <Text className="mt-2 text-[15px] font-medium text-missed">{jobError}</Text> : null}
        {planError?.key === 'new' ? <Text className="mt-3 text-[15px] font-medium text-missed">{planError.message}</Text> : null}
        {newPreview ? (
          <>
            <PlanPreview preview={newPreview} />
            <Button label={startLabel(newPreview)} icon="play-outline" loading={busy === 'job'} onPress={startNew} className="mt-4" />
          </>
        ) : (
          <Button label="Show Check Plan" icon="list-outline" loading={planLoading === 'new'} onPress={showPlan} className="mt-4" />
        )}
      </View>
    )
    return (
      <View className="rounded-2xl bg-surface p-4">
        <Text className="text-[17px] font-semibold text-ink">No job running</Text>
        <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-muted">
          {planned.length > 0
            ? 'Open an assigned job, or a different one with its Item Code and PO No. The department and its checks come from the Item Code: the pre-start checks first, then the checks during the job and at job end.'
            : 'Enter the Item Code and PO No. to see the job’s check plan. The department and its checks come from the Item Code: the pre-start checks first, then the checks during the job and at job end.'}
        </Text>
        {planned.length > 0 ? (
          <View className="mt-4 gap-2.5">
            <Text className="text-[15px] font-semibold text-ink-muted">Assigned jobs</Text>
            {planned.map((p) => (
              <View key={p.id} className="rounded-xl border border-line p-3">
                <Text className="text-[17px] font-semibold text-ink">PO No. {p.jobNo}</Text>
                <Text className="mt-0.5 text-[15px] text-ink-secondary">
                  {[
                    p.itemCode ? `Item Code ${p.itemCode}` : null,
                    p.departmentName ? `Department ${p.departmentName}` : null,
                    p.plannedFor ? `Planned for ${formatDate(p.plannedFor)}` : null
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Planned job'}
                </Text>
                {p.note ? <Text className="mt-0.5 text-[14px] text-ink-muted">{p.note}</Text> : null}
                {planError?.key === p.id ? <Text className="mt-2 text-[15px] font-medium text-missed">{planError.message}</Text> : null}
                {preview?.key === p.id ? (
                  <>
                    <PlanPreview preview={preview.data} />
                    <Button
                      label={startLabel(preview.data)}
                      icon="play-outline"
                      size="compact"
                      accessibilityLabel={`${startLabel(preview.data)} ${p.jobNo}`}
                      loading={busy === `plan:${p.id}`}
                      onPress={async () => {
                        if (await onStartPlanned(p)) setPreview(null)
                      }}
                      className="mt-3"
                    />
                  </>
                ) : (
                  <Button
                    label="View Check Plan"
                    icon="list-outline"
                    size="compact"
                    accessibilityLabel={`View Check Plan ${p.jobNo}`}
                    loading={planLoading === p.id}
                    onPress={() => loadPlan(p.id, { plannedJobId: p.id })}
                    className="mt-3"
                  />
                )}
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
    status === 'STARTING' ? { text: 'Pre-start checks pending', tone: 'text-due', dot: 'bg-due' }
    : status === 'ENDING' ? { text: 'Job end checks pending', tone: 'text-due', dot: 'bg-due' }
    : { text: 'Monitoring', tone: 'text-success', dot: 'bg-success' }

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="flex-row items-center">
        <View className={`mr-2 h-2 w-2 rounded-full ${head.dot}`} />
        <Text className="flex-1 text-[17px] font-semibold text-ink" accessibilityRole="header">
          Current Job
        </Text>
        {job.startedAt ? <Text className="text-[15px] text-ink-muted">Started {formatTime(job.startedAt)}</Text> : null}
      </View>
      {/* The department was worked out by the server from the Item Code and saved with the job: shown, never chosen here. */}
      <View className="mt-3 flex-row flex-wrap rounded-xl bg-subtle px-3 pt-2.5">
        <JobFact label="Item Code" value={job.itemCode || '—'} />
        <JobFact label="PO No." value={job.jobNo} />
        <JobFact label="Department" value={job.departmentName ? job.departmentName.toUpperCase() : '—'} />
        <JobFact label="Status" value={head.text} tone={head.tone} />
      </View>
      {machine.checkPlan ? (
        <>
          <Text className="mb-3 mt-4 text-[17px] font-semibold text-ink" accessibilityRole="header">
            Job Check Plan
          </Text>
          <CheckPlan plan={machine.checkPlan} status={status} checks={checks} canAct={mine} onOpenCheck={onOpenCheck} />
          {!mine ? (
            <View className="mt-3 flex-row items-start border-t border-line pt-3">
              <Icon name="person-outline" size={18} color="muted" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-muted">
                This job is with {job.assignedWorkerName ?? 'another worker'}. They can hand it over to you.
              </Text>
            </View>
          ) : status === 'ACTIVE' ? (
            <View className="mt-4 flex-row gap-2.5">
              <View className="flex-1">
                <Button label="Handover" icon="swap-horizontal-outline" variant="secondary" size="compact" onPress={onHandover} accessibilityLabel="Handover Job" />
              </View>
              <View className="flex-1">
                <Button label="End Job" icon="stop-circle-outline" variant="secondary" size="compact" loading={busy === 'job'} onPress={onEndJob} />
              </View>
            </View>
          ) : null}
        </>
      ) : !mine ? (
        // An older server sends no check plan: the job card as it was.
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
