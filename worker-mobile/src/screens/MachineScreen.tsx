import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl } from 'react-native'
import { ApiError, endJob, getMyMachines, getTodayChecks, startJob, startManualCheck } from '../services/api'
import { showDialog } from '../utils/dialog'
import { AssignedMachine, CheckSummary, MachineCheckType } from '../types'
import { formatTime } from '../utils/format'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { CheckRow } from '../components/ui/CheckRow'
import { Button } from '../components/ui/Button'
import { TextField } from '../components/ui/TextField'
import { FieldLabel } from '../components/ui/FieldLabel'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'

interface Props {
  machine: AssignedMachine
  refreshKey: number
  onBack: () => void
  /** Opens a check: without an action the form is shown, "exception" the exception form. */
  onStart: (checkId: string, action?: 'exception') => void
}

/** The one line that tells the worker what this check type needs right now. */
function statusLine(type: MachineCheckType, jobRunning: boolean): string {
  const open = type.openCheck
  if (open?.canSubmit) return 'Due now'
  if (open) return `Next check at ${formatTime(open.scheduledAt)}`
  if (type.mode === 'JOB' && !jobRunning) return 'Only during a job'
  if (type.nextDueAt) return `Next check at ${formatTime(type.nextDueAt)}`
  if (type.mode === 'MANUAL') return 'Manual submission'
  return 'Nothing due right now'
}

/** Step 2: the check types of this machine, each with Click Image (and Exception when due), and its job. */
export const MachineScreen: React.FC<Props> = ({ machine, refreshKey, onBack, onStart }) => {
  const [current, setCurrent] = useState<AssignedMachine>(machine)
  const [checks, setChecks] = useState<CheckSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [itemCode, setItemCode] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [jobError, setJobError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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

  const beginJob = async () => {
    const value = jobNo.trim()
    if (!value) return setJobError('Enter the Job No.')
    setJobError(null)
    setBusy('job')
    try {
      await startJob(current.id, value, itemCode.trim())
      setItemCode('')
      setJobNo('')
      await load()
    } catch (err) {
      showDialog('Could not start the job', err instanceof ApiError ? err.message : 'Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const finishJob = () => {
    if (!job) return
    showDialog('End this job?', `Job No. ${job.jobNo} will be closed. Checks nobody was told about disappear with it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End job',
        style: 'destructive',
        onPress: async () => {
          setBusy('job')
          try {
            await endJob(job.id)
            await load()
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
                    const dueNow = !!open?.canSubmit
                    const canAct = dueNow || type.canStart
                    return (
                      <View key={type.activityId} className="rounded-2xl bg-surface p-4">
                        <View className="flex-row items-center">
                          <View className={`mr-2 h-2 w-2 rounded-full ${dueNow ? 'bg-due' : 'bg-line-strong'}`} />
                          <Text className={`text-[15px] font-semibold ${dueNow ? 'text-due' : 'text-ink-muted'}`}>
                            {statusLine(type, !!job)}
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
                        ) : (
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

            {/* Job: only for machines that have job-based checks. */}
            {current.jobBased || job ? (
              <View>
                <SectionHeader size="large" title="Job" />
                {job ? (
                  <View className="rounded-2xl bg-surface p-4">
                    <View className="flex-row items-center">
                      <View className="mr-2 h-2 w-2 rounded-full bg-success" />
                      <Text className="flex-1 text-[15px] font-semibold text-success">Job running</Text>
                      <Text className="text-[15px] text-ink-muted">Started {formatTime(job.startedAt)}</Text>
                    </View>
                    <Text className="mt-1.5 text-[20px] font-semibold text-ink">Job No. {job.jobNo}</Text>
                    {job.itemCode ? <Text className="mt-0.5 text-[15px] text-ink-secondary">Item Code {job.itemCode}</Text> : null}
                    <Button
                      label="End job"
                      variant="secondary"
                      size="compact"
                      loading={busy === 'job'}
                      onPress={finishJob}
                      className="mt-4"
                    />
                  </View>
                ) : (
                  <View className="rounded-2xl bg-surface p-4">
                    <Text className="text-[17px] font-semibold text-ink">No job running</Text>
                    <Text className="mt-0.5 text-[15px] leading-[20px] text-ink-muted">
                      Job-based checks start once you begin a job on this machine.
                    </Text>
                    <View className="mt-4">
                      <FieldLabel label="Item Code" />
                      <TextField
                        placeholder="Enter Item Code"
                        value={itemCode}
                        onChangeText={setItemCode}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        maxLength={60}
                        accessibilityLabel="Item Code"
                      />
                      <View className="h-4" />
                      <FieldLabel label="Job No." />
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
                        accessibilityLabel="Job No."
                      />
                      {jobError ? <Text className="mt-2 text-[15px] font-medium text-missed">{jobError}</Text> : null}
                      <Button label="Start job" variant="tinted" loading={busy === 'job'} onPress={beginJob} className="mt-4" />
                    </View>
                  </View>
                )}
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
    </View>
  )
}
