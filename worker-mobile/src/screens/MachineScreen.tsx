import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl } from 'react-native'
import { ApiError, endJob, getMyMachines, getTodayChecks, startJob, startManualCheck } from '../services/api'
import { showDialog } from '../utils/dialog'
import { resyncLocalAlerts } from '../services/notifications'
import { AssignedMachine, CheckSummary, Job, MachineCheckType } from '../types'
import { formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { CheckRow } from '../components/ui/CheckRow'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { JobCard } from '../components/JobCard'
import { HandoverSheet } from '../components/HandoverSheet'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'

interface Props {
  machine: AssignedMachine
  /** The signed-in worker: a job assigned to someone else is shown read-only. */
  meId: string
  refreshKey: number
  onBack: () => void
  /** Opens a check: without an action the form is shown, "exception" the exception form. */
  onStart: (checkId: string, action?: 'exception') => void
  /** Opens a job's details and history. */
  onOpenJob: (jobId: string) => void
}

/** The one line that tells the worker what this check type needs right now. */
function statusLine(type: MachineCheckType, jobRunning: boolean): string {
  const open = type.openCheck
  // A job check names the parameters it asks for: only what is due.
  const names = open?.parameterNames?.length ? `: ${open.parameterNames.join(', ')}` : ''
  if (open?.canSubmit) return `Due now${names}`
  if (open) return `Next check at ${formatTime(open.scheduledAt)}${names}`
  if (type.mode === 'JOB' && !jobRunning) return 'Only during a job'
  if (type.nextDueAt) return `Next check at ${formatTime(type.nextDueAt)}`
  if (type.mode === 'MANUAL') return 'Manual submission'
  return 'Nothing due right now'
}

/** Step 2: the check types of this machine, each with Click Image (and Exception when due), and its job. */
export const MachineScreen: React.FC<Props> = ({ machine, meId, refreshKey, onBack, onStart, onOpenJob }) => {
  const [current, setCurrent] = useState<AssignedMachine>(machine)
  const [checks, setChecks] = useState<CheckSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [handingOver, setHandingOver] = useState(false)

  const load = useCallback(async () => {
    try {
      const [mine, today] = await Promise.all([getMyMachines(), getTodayChecks()])
      const fresh = mine.find((m) => m.id === machine.id)
      if (fresh) setCurrent(fresh)
      setChecks(today.filter((c) => c.machineId === machine.id))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [machine.id])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useAutoRefresh(load)

  const onPullRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const job = current.runningJob

  const openOrStart = async (type: MachineCheckType) => {
    if (type.openCheck?.canSubmit) return onStart(type.openCheck.id)
    setBusy(type.activityId)
    try {
      const started = await startManualCheck(current.id, type.activityId)
      onStart(started.id)
    } catch (err) {
      showDialog('Cannot start this check', err instanceof ApiError ? err.message : 'Please try again.')
      await load()
    } finally {
      setBusy(null)
    }
  }

  /** Start Job: the Job Start check opens straight away when the machine has one. */
  const begin = async (busyKey: string, request: Parameters<typeof startJob>[1]) => {
    setBusy(busyKey)
    try {
      const started = await startJob(current.id, request)
      await load()
      resyncLocalAlerts()
      const first = started.startChecks[0]
      if (first) onStart(first.id)
      else showDialog('Job started', `Job No. ${started.job.jobNo} is running. The scheduled checks follow the admin's plan.`)
    } catch (err) {
      showDialog('Could not start the job', err instanceof ApiError ? err.message : 'Please try again.')
    } finally {
      setBusy(null)
    }
  }

  /** End Job: opens the Job End check; the job completes when it is submitted. */
  const finishJob = () => {
    if (!job) return
    showDialog('End this job?', `Job No. ${job.jobNo}: you will check the Job End parameters and submit them to complete the job.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Job',
        style: 'destructive',
        onPress: async () => {
          setBusy('job')
          try {
            const ended = await endJob(job.id)
            await load()
            // Reminders of the job's withdrawn scheduled checks must not fire.
            resyncLocalAlerts()
            const first = ended.endChecks[0]
            if (first) onStart(first.id)
            else showDialog('Job completed', `Job No. ${job.jobNo} is completed.`)
          } catch (err) {
            showDialog('Could not end the job', err instanceof ApiError ? err.message : 'Please try again.')
          } finally {
            setBusy(null)
          }
        }
      }
    ])
  }

  const later = checks?.filter((c) => !c.canSubmit && c.status === 'PENDING') ?? []
  const done = checks?.filter((c) => !c.canSubmit && c.status !== 'PENDING').reverse() ?? []
  /** When something is due, only the due check types get the filled button. */
  const anyDue = current.checkTypes.some((t) => t.openCheck?.canSubmit)
  /** Due first, then the ones that can be started now, then the rest (stable within each group). */
  const rank = (t: MachineCheckType) => (t.openCheck?.canSubmit ? 0 : t.canStart ? 1 : 2)
  const orderedTypes = [...current.checkTypes].sort((a, b) => rank(a) - rank(b))
  /** Why this machine does not run today (plant closed, or left out of today's machine plan); null when it runs. */
  const offToday = current.runsToday === false ? current.notRunning ?? null : null
  const notRunning = current.runsToday === false

  return (
    <View className="flex-1 bg-canvas">
      <NavBar leftLabel="Machines" onLeftPress={onBack} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-12"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} />}
      >
        <View className="pb-6 pt-4">
          <Text className="text-[15px] font-medium text-ink-muted">{current.code}</Text>
          <Text className="mt-0.5 text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
            {current.name}
          </Text>
        </View>

        {checks === null && error ? (
          <ErrorState message={error} onRetry={load} />
        ) : checks === null ? (
          <Loading />
        ) : (
          <View className="gap-8">
            {notRunning ? (
              <View className="flex-row rounded-2xl bg-surface px-4 py-4" accessibilityRole="summary">
                <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-subtle">
                  <Icon name="moon-outline" size={20} color="secondary" />
                </View>
                <View className="flex-1">
                  <Text className="text-[17px] font-semibold text-ink">
                    {offToday && !offToday.planned ? 'Plant closed today' : 'Not scheduled to run today'}
                  </Text>
                  <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-muted">
                    {offToday?.message ?? 'This machine is not scheduled to run today.'} No checks are needed on it.
                  </Text>
                </View>
              </View>
            ) : null}

            {current.checkTypes.length === 0 ? (
              <EmptyState
                icon="clipboard-outline"
                title="No check set up"
                message="Ask your supervisor to link a quality check to this machine."
              />
            ) : (
              <View>
                <SectionHeader size="large" title="Checks" />
                <View className="gap-3">
                  {orderedTypes.map((type) => {
                    const open = type.openCheck
                    const dueNow = !notRunning && !!open?.canSubmit
                    const canAct = dueNow || (!notRunning && type.canStart)
                    return (
                      <View key={type.activityId} className="rounded-2xl bg-surface p-4">
                        <View className="flex-row items-center">
                          <View className={`mr-2 h-2 w-2 rounded-full ${dueNow ? 'bg-due' : 'bg-line-strong'}`} />
                          <Text className={`text-[15px] font-semibold ${dueNow ? 'text-due' : 'text-ink-muted'}`}>
                            {notRunning ? 'Not running today' : statusLine(type, !!job)}
                          </Text>
                        </View>
                        <Text className="mt-1.5 text-[20px] font-semibold leading-[26px] text-ink">{type.activityName}</Text>
                        {dueNow && open ? (
                          <Text className="mt-0.5 text-[15px] text-ink-secondary">
                            Due {formatTime(open.scheduledAt)} · open until {formatTime(open.windowEndsAt)}
                          </Text>
                        ) : type.lastSubmittedAt ? (
                          <Text className="mt-0.5 text-[15px] text-ink-muted">Last done {formatTime(type.lastSubmittedAt)}</Text>
                        ) : type.description ? (
                          <Text className="mt-0.5 text-[15px] text-ink-muted" numberOfLines={2}>
                            {type.description}
                          </Text>
                        ) : null}

                        {canAct ? (
                          <View className="mt-4 gap-2.5">
                            <Button
                              label="Click Image"
                              icon="camera-outline"
                              variant={dueNow || !anyDue ? 'primary' : 'tinted'}
                              accessibilityLabel={`Click Image: ${type.activityName}`}
                              loading={busy === type.activityId}
                              onPress={() => openOrStart(type)}
                            />
                            {dueNow && open ? (
                              <Button
                                label="Exception"
                                icon="alert-circle-outline"
                                variant="warning"
                                size="compact"
                                accessibilityLabel={`Exception: ${type.activityName}`}
                                onPress={() => onStart(open.id, 'exception')}
                              />
                            ) : null}
                          </View>
                        ) : notRunning ? null : (
                          <View className="mt-3 flex-row items-start border-t border-line pt-3">
                            <Icon name="information-circle-outline" size={18} color="muted" />
                            <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-muted">
                              {type.startMessage ?? 'This check can only be done when it is due.'}
                            </Text>
                          </View>
                        )}
                      </View>
                    )
                  })}
                </View>
              </View>
            )}

            {/* Job: for machines with job-based checks, a planned job or a running job. */}
            {(current.jobBased && !notRunning) || job || (current.plannedJobs?.length && !notRunning) ? (
              <View>
                <SectionHeader size="large" title="Job" />
                <JobCard
                  machine={current}
                  meId={meId}
                  busy={busy}
                  onStartPlanned={(planned: Job) => begin(`plan:${planned.id}`, { plannedJobId: planned.id })}
                  onStartNew={(jobNo, itemCode) => begin('job', { jobNo, itemCode })}
                  onOpenCheck={(id) => onStart(id)}
                  onEndJob={finishJob}
                  onHandover={() => setHandingOver(true)}
                  onOpenJob={() => job && onOpenJob(job.id)}
                />
              </View>
            ) : null}

            {later.length > 0 && (
              <View>
                <SectionHeader title="Later today" />
                <ListGroup>
                  {later.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ListGroup>
              </View>
            )}

            {done.length > 0 && (
              <View>
                <SectionHeader title="Earlier today" />
                <ListGroup>
                  {done.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ListGroup>
              </View>
            )}

            {error ? <Text className="px-4 text-[14px] text-missed">Could not refresh: {error}</Text> : null}
          </View>
        )}
      </ScrollView>
      {job ? (
        <HandoverSheet
          visible={handingOver}
          job={job}
          onCancel={() => setHandingOver(false)}
          onDone={async (toName) => {
            setHandingOver(false)
            await load()
            // This job's reminders now belong to the next worker.
            resyncLocalAlerts()
            showDialog('Job handed over', `${toName} now has Job No. ${job.jobNo} and its pending checks. They have been notified.`)
          }}
        />
      ) : null}
    </View>
  )
}
