import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, BackHandler, KeyboardAvoidingView, Platform, TextInput } from 'react-native'
import { ApiError, endJob, getCheckForm, getTodayChecks, submitCheck, submitException } from '../services/api'
import { showDialog } from '../utils/dialog'
import { syncLocalAlerts } from '../services/notifications'
import { Capture, CheckForm, EvidenceUpload, FormParameter, SubmitResult, SubmitValue } from '../types'
import { formatTime } from '../utils/format'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { ActionBar } from '../components/ui/ActionBar'
import { Button } from '../components/ui/Button'
import { PLACEHOLDER_COLOR, TextField } from '../components/ui/TextField'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { RadioMark } from '../components/RadioMark'
import { numberStatus } from '../components/ParameterField'
import { ParameterCard, needsPhoto, type NaChoice } from '../components/ParameterCard'
import { EvidenceField } from '../components/EvidenceField'
import { NaReasonSheet } from '../components/NaReasonSheet'
import { SubmitSuccess } from '../components/SubmitSuccess'
import { CameraModal } from '../components/CameraModal'
import { KIND_LABEL } from './JobScreen'
import { ContinueJobSheet } from '../components/ContinueJobSheet'

interface Props {
  checkId: string
  onClose: (submitted: boolean) => void
  /** "exception" opens the exception form straight away; otherwise the check form is shown. */
  startWith?: 'exception'
  /** Opens another check next, e.g. the Job End check after "End Job" or the next Job Start check. */
  onOpenCheck?: (checkId: string) => void
}

/** Which camera is open and which multipart field the capture belongs to. */
type CameraTarget = { mode: 'photo' | 'video'; field: string; label: string }

const photoField = (parameterId: string) => `photo:${parameterId}`
const videoField = (parameterId: string) => `video:${parameterId}`

/** Everything a parameter still needs, empty when it is complete. */
function whatIsMissing(p: FormParameter, value: string, na: NaChoice | null, media: Record<string, Capture>): string[] {
  if (!p.applicable || na) return []
  const missing: string[] = []
  if (p.isRequired && p.type !== 'PHOTO' && !value.trim()) missing.push('Value')
  if (needsPhoto(p) && !media[photoField(p.id)]) missing.push('Photo')
  if (p.requireVideo && !media[videoField(p.id)]) missing.push('Video')
  return missing
}

/**
 * Whether the worker has completed this parameter: answered it (a value, a photo or video, or
 * Not applicable) with nothing required still missing. An optional parameter left empty is not
 * "done", so it gets no green tick. A job-only parameter with no job is recorded as Not
 * Applicable automatically, so it counts towards the progress.
 */
function isDone(p: FormParameter, value: string, na: NaChoice | null, media: Record<string, Capture>): boolean {
  if (!p.applicable || na) return true
  const answered = !!value.trim() || !!media[photoField(p.id)] || !!media[videoField(p.id)]
  return answered && whatIsMissing(p, value, na, media).length === 0
}

export const CheckScreen: React.FC<Props> = ({ checkId, onClose, startWith, onOpenCheck }) => {
  const [form, setForm] = useState<CheckForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'check' | 'exception'>(startWith === 'exception' ? 'exception' : 'check')
  const [camera, setCamera] = useState<CameraTarget | null>(null)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<SubmitResult | null>(null)
  /** "Continue the job or end the job?" after a scheduled job check. */
  const [askJob, setAskJob] = useState(false)
  const [endingJob, setEndingJob] = useState(false)

  // Check form
  const [itemCode, setItemCode] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [na, setNa] = useState<Record<string, NaChoice>>({})
  /** Captures by multipart field name: `photo:<parameterId>`, `video:<parameterId>`, `photo`, `video`. */
  const [media, setMedia] = useState<Record<string, Capture>>({})
  const [naFor, setNaFor] = useState<FormParameter | null>(null)
  const [missing, setMissing] = useState<Record<string, string[]>>({})
  const [missingOverall, setMissingOverall] = useState<string[]>([])

  // Exception form
  const [reason, setReason] = useState<string | null>(null)
  const [remark, setRemark] = useState('')
  const [exceptionPhoto, setExceptionPhoto] = useState<Capture | null>(null)

  const scroller = useRef<ScrollView | null>(null)
  const cardsTop = useRef(0)
  const cardY = useRef<Record<string, number>>({})

  // The form configuration is always loaded fresh, so admin changes apply immediately.
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const next = await getCheckForm(checkId)
      setForm(next)
      // A running job fixes the Item Code and Job No.; otherwise keep whatever the worker typed.
      if (next.job) {
        setItemCode(next.job.itemCode ?? '')
        setJobNo(next.job.jobNo)
      } else {
        if (next.check.itemCode) setItemCode(next.check.itemCode)
        if (next.check.jobNo) setJobNo(next.check.jobNo)
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [checkId])

  useEffect(() => {
    load()
  }, [load])

  const hasInput = !!(
    Object.keys(media).length ||
    Object.keys(na).length ||
    Object.values(values).some(Boolean) ||
    reason ||
    remark ||
    exceptionPhoto
  )

  const goBack = useCallback(() => {
    if (sending) return true
    if (result) {
      onClose(true)
      return true
    }
    // Opened as an exception: Back leaves; opened from the check form: Back returns to it.
    if (mode === 'exception' && startWith !== 'exception') {
      setMode('check')
      return true
    }
    if (hasInput) {
      showDialog('Leave this check?', 'What you entered will be lost.', [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: () => onClose(false) }
      ])
    } else {
      onClose(false)
    }
    return true
  }, [hasInput, mode, onClose, result, sending, startWith])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', goBack)
    return () => sub.remove()
  }, [goBack])

  const handleError = (title: string, err: unknown) => {
    const message = err instanceof ApiError ? err.message : 'Please try again.'
    showDialog(title, message)
    // The check may have closed or changed on the server; reload its state.
    if (err instanceof ApiError && err.status === 409) load()
  }

  const parameters = form?.parameters ?? []
  const doneCount = useMemo(
    () => parameters.filter((p) => isDone(p, values[p.id] ?? '', na[p.id] ?? null, media)).length,
    [parameters, values, na, media]
  )

  /** After a failed submit: jump to the first card that still needs something. */
  const scrollToFirst = (parameterId: string | null) => {
    const y = parameterId ? cardsTop.current + (cardY.current[parameterId] ?? 0) : 0
    scroller.current?.scrollTo({ y: Math.max(y - 16, 0), animated: true })
  }

  const sendCheck = async () => {
    if (!form) return
    const perParameter: Record<string, string[]> = {}
    for (const p of parameters) {
      const items = whatIsMissing(p, values[p.id] ?? '', na[p.id] ?? null, media)
      if (items.length) perParameter[p.id] = items
    }
    const overall: string[] = []
    if (form.activity.requireJobNo && !jobNo.trim()) overall.push('Job No.')
    if (form.activity.requirePhoto && !media.photo) overall.push('Check photo')
    if (form.activity.requireVideo && !media.video) overall.push('Check video')

    setMissing(perParameter)
    setMissingOverall(overall)
    if (Object.keys(perParameter).length || overall.length) {
      const first = parameters.find((p) => perParameter[p.id])
      scrollToFirst(overall.length ? null : (first?.id ?? null))
      return
    }

    const submitValues: SubmitValue[] = []
    for (const p of parameters) {
      if (!p.applicable) continue
      const choice = na[p.id]
      if (choice) {
        submitValues.push({
          parameterId: p.id,
          notApplicable: true,
          naReasonId: choice.reasonId,
          naRemark: choice.remark || null
        })
      } else if ((values[p.id] ?? '').trim()) {
        submitValues.push({ parameterId: p.id, value: values[p.id].trim() })
      }
    }
    const files: EvidenceUpload[] = Object.entries(media).map(([field, capture]) => ({ field, capture }))

    setSending(true)
    setProgress(0)
    try {
      const submitted = await submitCheck(checkId, { itemCode: itemCode.trim(), jobNo: jobNo.trim(), values: submitValues, media: files }, setProgress)
      setResult(submitted)
      if (submitted.askContinue && submitted.job) setAskJob(true)
      // Checks may have been cancelled or moved by this submission: rebuild the local alerts.
      getTodayChecks()
        .then(syncLocalAlerts)
        .catch(() => undefined)
    } catch (err) {
      handleError('Could not submit', err)
    } finally {
      setSending(false)
    }
  }

  /** End Job from "Continue or end?": the Job End check opens next; with none, the job is completed. */
  const endJobNow = async () => {
    const job = result?.job
    if (!job) return
    setEndingJob(true)
    try {
      const ended = await endJob(job.id)
      setAskJob(false)
      // Reminders of the job's withdrawn scheduled checks must not fire.
      getTodayChecks()
        .then(syncLocalAlerts)
        .catch(() => undefined)
      const first = ended.endChecks[0]
      if (first && onOpenCheck) onOpenCheck(first.id)
      else {
        showDialog('Job completed', `Job No. ${job.jobNo} is completed.`)
        onClose(true)
      }
    } catch (err) {
      showDialog('Could not end the job', err instanceof ApiError ? err.message : 'Please try again.')
    } finally {
      setEndingJob(false)
    }
  }

  /** The job's next open check for this worker (e.g. another check type's Job Start check), if any. */
  const nextJobCheck = result?.pendingJobChecks?.find((c) => c.id !== checkId && c.canSubmit && (c.kind === 'JOB_START' || c.kind === 'JOB_END'))

  const sendException = async () => {
    const items: string[] = []
    if (!reason) items.push('Reason')
    if (reason === 'Other' && !remark.trim()) items.push('Remark')
    if (!exceptionPhoto) items.push('Photo')
    if (items.length || !reason || !exceptionPhoto) {
      showDialog('Please complete', items.join('\n'))
      return
    }

    setSending(true)
    setProgress(0)
    try {
      await submitException(checkId, { reason, remark: remark.trim(), photo: exceptionPhoto }, setProgress)
      showDialog('Exception sent', 'Your supervisor will review it.', [{ text: 'OK', onPress: () => onClose(true) }])
    } catch (err) {
      handleError('Could not send', err)
    } finally {
      setSending(false)
    }
  }

  const onCaptured = (capture: Capture) => {
    if (!camera) return
    if (camera.field === 'exception') {
      setExceptionPhoto(capture)
      setCamera(null)
      return
    }
    setMedia((prev) => ({ ...prev, [camera.field]: capture }))
    // This file is no longer missing.
    const [kind, parameterId] = camera.field.split(':')
    const item = kind === 'photo' ? 'Photo' : 'Video'
    if (parameterId) {
      setMissing((prev) => {
        const left = (prev[parameterId] ?? []).filter((m) => m !== item)
        const next = { ...prev }
        if (left.length) next[parameterId] = left
        else delete next[parameterId]
        return next
      })
    } else {
      setMissingOverall((prev) => prev.filter((m) => m !== `Check ${item.toLowerCase()}`))
    }
    setCamera(null)
  }

  if (!form) {
    return (
      <View className="flex-1 bg-canvas">
        <NavBar leftLabel="Back" onLeftPress={() => onClose(false)} />
        <View className="flex-1 px-5 pt-6">
          {loadError ? <ErrorState message={loadError} onRetry={load} /> : <Loading label="Opening the check…" />}
        </View>
      </View>
    )
  }

  const { check, activity, job } = form

  if (result) {
    const outOfRange = parameters.some((p) => {
      const raw = values[p.id]?.trim() ?? ''
      return p.type === 'PASS_FAIL' ? raw.toUpperCase() === 'FAIL' : p.type === 'NUMBER' && numberStatus(p, raw) === 'out'
    })
    return (
      <>
        <SubmitSuccess
          result={result}
          activityName={activity.name}
          outOfRange={outOfRange}
          onDone={() => (nextJobCheck && onOpenCheck ? onOpenCheck(nextJobCheck.id) : onClose(true))}
          doneLabel={nextJobCheck ? `Next: ${KIND_LABEL[nextJobCheck.kind ?? 'SCHEDULED']}` : undefined}
        />
        {result.job ? (
          <ContinueJobSheet
            visible={askJob}
            jobNo={result.job.jobNo}
            itemCode={result.job.itemCode}
            ending={endingJob}
            onContinue={() => setAskJob(false)}
            onEnd={endJobNow}
          />
        ) : null}
      </>
    )
  }

  const missingSummary = [
    ...missingOverall,
    ...parameters.filter((p) => missing[p.id]?.length).map((p) => `${p.name} (${missing[p.id].join(', ')})`)
  ]
  const sendingLabel = progress > 0 && progress < 1 ? `Sending… ${Math.round(progress * 100)}%` : 'Sending…'
  const startedBy = check.submissionType === 'MANUAL' ? 'Started by you' : `Due ${formatTime(check.scheduledAt)}`
  const showOverallEvidence = activity.requirePhoto || activity.requireVideo

  // The next photo/video to take, in form order: drawn in the accent tint so the next step is obvious.
  let nextStep: { parameterId: string; kind: 'photo' | 'video' } | null = null
  for (const p of parameters) {
    if (!p.applicable || na[p.id]) continue
    if (needsPhoto(p) && !media[photoField(p.id)]) nextStep = { parameterId: p.id, kind: 'photo' }
    else if (p.requireVideo && !media[videoField(p.id)]) nextStep = { parameterId: p.id, kind: 'video' }
    if (nextStep) break
  }
  const jobNoMissing = missingOverall.includes('Job No.')

  return (
    <View className="flex-1 bg-canvas">
      {mode === 'check' ? (
        <>
          <NavBar
            leftLabel="Back"
            onLeftPress={goBack}
            rightLabel={check.canSubmit && form.allowException !== false ? 'Exception' : undefined}
            onRightPress={() => setMode('exception')}
            rightTone="exception"
          />
          <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView
              ref={scroller}
              className="flex-1"
              contentContainerClassName="px-5 pb-10"
              keyboardShouldPersistTaps="handled"
            >
              <View className="pb-6 pt-4">
                <Text className="text-[15px] font-medium text-ink-muted">
                  {check.machineName}
                  {check.kind && check.kind !== 'SCHEDULED' ? ` · ${KIND_LABEL[check.kind]}` : ''}
                </Text>
                <Text className="mt-0.5 text-[28px] font-bold leading-[34px] tracking-[-0.5px] text-ink" accessibilityRole="header">
                  {activity.name}
                </Text>
                <Text className="mt-1 text-[15px] text-ink-secondary">{startedBy}</Text>
                {check.canSubmit && parameters.length > 0 ? (
                  <View className="mt-5">
                    <ProgressBar done={doneCount} total={parameters.length} label={`${doneCount} of ${parameters.length} done`} />
                  </View>
                ) : null}
              </View>

              {!check.canSubmit ? (
                <EmptyState icon="lock-closed-outline" title="This check is closed" message={check.message ?? undefined} />
              ) : (
                <View className="gap-7">
                  <View>
                    <SectionHeader title="Job details" />
                    <ListGroup>
                      {job ? (
                        [
                          job.itemCode ? <LockedRow key="item" label="Item Code" value={job.itemCode} /> : null,
                          <LockedRow key="job" label="Job No." value={job.jobNo} />
                        ]
                      ) : (
                        [
                          <InlineField
                            key="item"
                            label="Item Code"
                            placeholder="Enter Item Code"
                            value={itemCode}
                            onChangeText={setItemCode}
                            maxLength={60}
                          />,
                          <InlineField
                            key="job"
                            label="Job No."
                            placeholder="Enter Job No."
                            value={jobNo}
                            invalid={jobNoMissing}
                            onChangeText={(text) => {
                              setJobNo(text)
                              setMissingOverall((prev) => prev.filter((m) => m !== 'Job No.'))
                            }}
                          />
                        ]
                      )}
                    </ListGroup>
                    <Text className="mt-2 px-4 text-[13px] text-ink-muted">
                      {job
                        ? job.startedAt
                          ? `From the job running since ${formatTime(job.startedAt)}.`
                          : 'From the job.'
                        : activity.requireJobNo
                          ? 'Job No. is required for this check.'
                          : 'Job No. is optional for this check.'}
                    </Text>
                  </View>

                  {parameters.length > 0 && (
                    <View onLayout={(e) => (cardsTop.current = e.nativeEvent.layout.y)}>
                      <SectionHeader title="Readings" detail={`${parameters.length}`} />
                      <View className="gap-3">
                        {parameters.map((p, index) => (
                          <ParameterCard
                            key={p.id}
                            parameter={p}
                            index={index + 1}
                            value={values[p.id] ?? ''}
                            na={na[p.id] ?? null}
                            photo={media[photoField(p.id)] ?? null}
                            video={media[videoField(p.id)] ?? null}
                            done={isDone(p, values[p.id] ?? '', na[p.id] ?? null, media)}
                            missing={missing[p.id]}
                            highlight={nextStep?.parameterId === p.id ? nextStep.kind : null}
                            onLayout={(e) => (cardY.current[p.id] = e.nativeEvent.layout.y)}
                            onChange={(value) => {
                              setValues((prev) => ({ ...prev, [p.id]: value }))
                              setMissing((prev) => {
                                const left = (prev[p.id] ?? []).filter((m) => m !== 'Value')
                                const next = { ...prev }
                                if (left.length) next[p.id] = left
                                else delete next[p.id]
                                return next
                              })
                            }}
                            onCapture={(kind) =>
                              setCamera({
                                mode: kind,
                                field: kind === 'photo' ? photoField(p.id) : videoField(p.id),
                                label: p.name
                              })
                            }
                            onMarkNa={() => setNaFor(p)}
                            onClearNa={() =>
                              setNa((prev) => {
                                const next = { ...prev }
                                delete next[p.id]
                                return next
                              })
                            }
                          />
                        ))}
                      </View>
                    </View>
                  )}

                  {showOverallEvidence && (
                    <View>
                      <SectionHeader title="Whole check" detail="Overall evidence" />
                      <View className="gap-3">
                        {activity.requirePhoto ? (
                          <EvidenceField
                            kind="photo"
                            capture={media.photo ?? null}
                            required
                            highlight={!nextStep}
                            onOpenCamera={() => setCamera({ mode: 'photo', field: 'photo', label: 'Check photo' })}
                          />
                        ) : null}
                        {activity.requireVideo ? (
                          <EvidenceField
                            kind="video"
                            capture={media.video ?? null}
                            required
                            highlight={!nextStep && (!activity.requirePhoto || !!media.photo)}
                            onOpenCamera={() => setCamera({ mode: 'video', field: 'video', label: 'Check video' })}
                          />
                        ) : null}
                      </View>
                    </View>
                  )}
                </View>
              )}
            </ScrollView>

            {check.canSubmit && (
              <ActionBar>
                {missingSummary.length ? (
                  <View className="mb-3 flex-row items-start rounded-xl bg-missed-bg px-3 py-2.5">
                    <Icon name="alert-circle" size={18} color="missed" />
                    <Text className="ml-2 flex-1 text-[14px] leading-[19px] text-missed">Still needed: {missingSummary.join(', ')}</Text>
                  </View>
                ) : null}
                <Button label={sending ? sendingLabel : 'Submit'} onPress={sendCheck} loading={sending} />
                {sending ? (
                  <View className="mt-3">
                    <ProgressBar done={Math.round(progress * 100)} total={100} />
                  </View>
                ) : null}
              </ActionBar>
            )}
          </KeyboardAvoidingView>
        </>
      ) : (
        <>
          <NavBar leftLabel="Back" onLeftPress={goBack} title="Exception" />
          <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10" keyboardShouldPersistTaps="handled">
              <View className="pb-6 pt-4">
                <Text className="text-[15px] font-medium text-ink-muted">
                  {check.machineName} · {activity.name}
                </Text>
                <Text className="mt-0.5 text-[28px] font-bold leading-[34px] tracking-[-0.5px] text-ink" accessibilityRole="header">
                  Can&apos;t do this check?
                </Text>
                <Text className="mt-1 text-[15px] text-ink-secondary">Tell us why and take a photo.</Text>
              </View>

              <View className="gap-7">
                <View>
                  <SectionHeader title="Reason" />
                  <ListGroup inset="radio">
                    {form.exceptionReasons.map((r) => {
                      const selected = reason === r
                      return (
                        <Pressable
                          key={r}
                          onPress={() => setReason(r)}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: selected }}
                          accessibilityLabel={r}
                          className="min-h-[56px] flex-row items-center px-4 py-3 active:bg-subtle"
                        >
                          <RadioMark selected={selected} />
                          <Text className={`ml-3 flex-1 text-[17px] text-ink ${selected ? 'font-semibold' : ''}`}>{r}</Text>
                        </Pressable>
                      )
                    })}
                  </ListGroup>
                </View>

                <View>
                  <View className="mb-2 flex-row items-baseline justify-between px-4">
                    <Text className="text-[15px] font-semibold text-ink-muted">Remark</Text>
                    <Text className="text-[13px] text-ink-muted">{reason === 'Other' ? 'Required' : 'Optional'}</Text>
                  </View>
                  <TextField multiline variant="outlined" placeholder="What happened?" value={remark} onChangeText={setRemark} />
                </View>

                <View>
                  <SectionHeader title="Photo" />
                  <EvidenceField
                    kind="photo"
                    capture={exceptionPhoto}
                    required
                    highlight={!!reason}
                    onOpenCamera={() => setCamera({ mode: 'photo', field: 'exception', label: 'Exception photo' })}
                  />
                </View>
              </View>
            </ScrollView>

            <ActionBar>
              <Button label={sending ? sendingLabel : 'Submit Exception'} onPress={sendException} loading={sending} />
              {sending ? (
                <View className="mt-3">
                  <ProgressBar done={Math.round(progress * 100)} total={100} />
                </View>
              ) : null}
            </ActionBar>
          </KeyboardAvoidingView>
        </>
      )}

      <NaReasonSheet
        visible={naFor !== null}
        parameterName={naFor?.name ?? ''}
        reasons={form.naReasons}
        current={naFor ? (na[naFor.id] ?? null) : null}
        onCancel={() => setNaFor(null)}
        onConfirm={(choice) => {
          if (naFor) {
            setNa((prev) => ({ ...prev, [naFor.id]: choice }))
            setMissing((prev) => {
              const next = { ...prev }
              delete next[naFor.id]
              return next
            })
          }
          setNaFor(null)
        }}
      />

      <CameraModal
        visible={camera !== null}
        mode={camera?.mode ?? 'photo'}
        maxVideoSeconds={form.maxVideoSeconds}
        onCancel={() => setCamera(null)}
        onDone={onCaptured}
      />
    </View>
  )
}

/** One row of a grouped form: label on the left, the value typed on the right. */
const InlineField: React.FC<{
  label: string
  placeholder: string
  value: string
  onChangeText: (text: string) => void
  maxLength?: number
  invalid?: boolean
}> = ({ label, placeholder, value, onChangeText, maxLength, invalid = false }) => (
  <View className="min-h-[56px] flex-row items-center px-4">
    <Text className={`w-[96px] text-[17px] ${invalid ? 'font-semibold text-missed' : 'text-ink'}`}>{label}</Text>
    <TextInput
      placeholder={placeholder}
      placeholderTextColor={PLACEHOLDER_COLOR}
      value={value}
      onChangeText={onChangeText}
      maxLength={maxLength}
      autoCapitalize="characters"
      autoCorrect={false}
      accessibilityLabel={label}
      className="h-14 flex-1 py-0 text-right text-[17px] text-ink"
      style={Platform.OS === 'web' ? ({ outlineStyle: 'none', minWidth: 0 } as object) : undefined}
    />
  </View>
)

/** A value fixed by the running job. */
const LockedRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View className="min-h-[56px] flex-row items-center px-4" accessibilityLabel={`${label} ${value}, fixed by the running job`}>
    <Text className="w-[96px] text-[17px] text-ink">{label}</Text>
    <Text className="flex-1 text-right text-[17px] font-semibold text-ink" numberOfLines={1}>
      {value}
    </Text>
    <View className="ml-2">
      <Icon name="lock-closed" size={15} color="faint" />
    </View>
  </View>
)
