import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, BackHandler, Platform, TextInput, Modal, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAvoider, KeyboardAwareScrollView, useRevealInput, type KeyboardAwareScrollViewHandle } from '../utils/keyboard'
import { ApiError, endJob, getCheckForm, getCheckRecord, getTodayChecks, submitCheck, submitException } from '../services/api'
import { draftStorage } from '../services/storage'
import { showDialog, showError, showMissingItems, showSuccess } from '../utils/dialog'
import type { DialogItem } from '../components/ui/AppDialog'
import { describeError } from '../utils/friendlyError'
import { syncLocalAlerts } from '../services/notifications'
import { Capture, CheckForm, EvidenceUpload, FormParameter, SubmitResult, SubmitValue } from '../types'
import { formatTime } from '../utils/format'
import { ITEM_CODE_ERROR, itemCodeError } from '../utils/itemCode'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { ActionBar } from '../components/ui/ActionBar'
import { Button } from '../components/ui/Button'
import { ACCENT, INK, PLACEHOLDER_COLOR, TextField } from '../components/ui/TextField'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { RadioMark } from '../components/RadioMark'
import { hasMaterial, materialAnswer, numberStatus } from '../components/ParameterField'
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
  // A dropdown that asks for a material needs both halves before it counts as answered.
  else if (hasMaterial(p) && value.trim()) {
    const answer = materialAnswer(p, value)
    if (!answer.material) missing.push('Material')
    else if (!answer.option) missing.push('Value')
  }
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

/**
 * What the worker typed on a check not sent yet, kept on the phone while they work so closing the
 * app or leaving the check does not lose it. Photos and videos are not kept: they are taken again.
 */
interface CheckDraft {
  values: Record<string, string>
  na: Record<string, NaChoice>
  itemCode?: string
  jobNo?: string
  machineId?: string
  reason?: string | null
  remark?: string
}

function readDraft(raw: string | null): CheckDraft | null {
  if (!raw) return null
  try {
    const draft = JSON.parse(raw) as CheckDraft
    return draft && typeof draft === 'object' && draft.values && draft.na ? draft : null
  } catch {
    return null
  }
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
  const [selectedMachineId, setSelectedMachineId] = useState('')
  const [machinesList, setMachinesList] = useState<{ id: string; name: string; code?: string }[]>([])
  const [machineModalOpen, setMachineModalOpen] = useState(false)
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
  /** Readings typed earlier (before the app closed or the shift ended) were put back. */
  const [restoredDraft, setRestoredDraft] = useState(false)
  const [exceptionPhoto, setExceptionPhoto] = useState<Capture | null>(null)

  const scroller = useRef<KeyboardAwareScrollViewHandle | null>(null)
  const cardsTop = useRef(0)
  const cardY = useRef<Record<string, number>>({})
  /**
   * Set the moment a submit, an exception or End Job starts, before React re-renders: a quick
   * double tap must not send the same check (and its videos) twice.
   */
  const sendingRef = useRef(false)
  const endingRef = useRef(false)
  /** The draft is saved only after it was restored, and no more once the check was sent. */
  const draftReady = useRef(false)
  const draftDone = useRef(false)

  // The form configuration is always loaded fresh, so admin changes apply immediately.
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const next = await getCheckForm(checkId)
      setForm(next)
      // A job's check uses the job's Item Code and PO No. (the server does too, whatever is sent);
      // other checks are filled in by the worker, starting from what the check already has.
      if (next.job) {
        setItemCode(next.job.itemCode ?? '')
        setJobNo(next.job.jobNo)
      } else {
        if (next.check.itemCode) setItemCode(next.check.itemCode)
        if (next.check.jobNo) setJobNo(next.check.jobNo)
      }
      if (next.check.machineId) setSelectedMachineId(next.check.machineId)
      setMachinesList(next.machines ?? [])

      // Opened again before it was sent: put back what the worker had typed.
      if (!draftReady.current) {
        const draft = readDraft(await draftStorage.get(checkId))
        if (draft) {
          const ids = new Set(next.parameters.filter((p) => p.applicable).map((p) => p.id))
          // Only parameters the form still has (an Admin may have changed it meanwhile).
          setValues(Object.fromEntries(Object.entries(draft.values).filter(([id]) => ids.has(id))))
          setNa(Object.fromEntries(Object.entries(draft.na).filter(([id]) => ids.has(id))))
          if (!next.job && !next.check.jobId) {
            if (draft.itemCode) setItemCode(draft.itemCode)
            if (draft.jobNo) setJobNo(draft.jobNo)
          }
          if (!next.check.machineId && draft.machineId && (next.machines ?? []).some((m) => m.id === draft.machineId)) {
            setSelectedMachineId(draft.machineId)
          }
          if (draft.reason && next.exceptionReasons.includes(draft.reason)) setReason(draft.reason)
          if (draft.remark) setRemark(draft.remark)
          setRestoredDraft(true)
        }
        draftReady.current = true
      }
    } catch (err) {
      const e = describeError(err, 'Could not open the check')
      setLoadError([e.message, e.next].filter(Boolean).join(' '))
    }
  }, [checkId])

  useEffect(() => {
    load()
  }, [load])

  // Keeps the typed readings and Not Applicable choices on the phone while the worker works
  // (shortly after the last change), so they are back if the app is closed or the check left.
  useEffect(() => {
    if (!draftReady.current || draftDone.current) return
    const timer = setTimeout(() => {
      if (draftDone.current) return
      const draft: CheckDraft = { values, na, itemCode, jobNo, machineId: selectedMachineId, reason, remark }
      const empty = !Object.values(values).some(Boolean) && !Object.keys(na).length && !reason && !remark
      if (empty) draftStorage.remove(checkId)
      else draftStorage.set(checkId, JSON.stringify(draft))
    }, 400)
    return () => clearTimeout(timer)
  }, [checkId, values, na, itemCode, jobNo, selectedMachineId, reason, remark])

  /** The check was sent: its draft is no longer needed. */
  const dropDraft = () => {
    draftDone.current = true
    draftStorage.remove(checkId)
  }

  const hasInput = !!(
    Object.keys(media).length ||
    Object.keys(na).length ||
    Object.values(values).some(Boolean) ||
    itemCode ||
    jobNo ||
    selectedMachineId ||
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
      // Typed readings are kept as a draft (above); only the photos and videos are not.
      const message = Object.keys(media).length || exceptionPhoto
        ? 'Your readings are kept on this phone for when you open it again, but the photos and videos will need to be taken again.'
        : 'Your readings are kept on this phone for when you open it again.'
      showDialog('Leave this check?', message, [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: () => onClose(false) }
      ])
    } else {
      onClose(false)
    }
    return true
  }, [exceptionPhoto, hasInput, media, mode, onClose, result, sending, startWith])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', goBack)
    return () => sub.remove()
  }, [goBack])

  const handleError = (title: string, err: unknown, retry?: () => void) => {
    showError(err, { title, onRetry: retry })
    // The check may have closed or changed on the server; reload its state.
    if (err instanceof ApiError && err.status === 409) load()
  }

  const parameters = form?.parameters ?? []
  const doneCount = useMemo(
    () => parameters.filter((p) => isDone(p, values[p.id] ?? '', na[p.id] ?? null, media)).length,
    [parameters, values, na, media]
  )
  const selectedMachine = useMemo(
    () => machinesList.find((m) => m.id === selectedMachineId),
    [machinesList, selectedMachineId]
  )

  /** After a failed submit: jump to the first card that still needs something. */
  const scrollToFirst = (parameterId: string | null) => {
    const y = parameterId ? cardsTop.current + (cardY.current[parameterId] ?? 0) : 0
    scroller.current?.scrollTo({ y: Math.max(y - 16, 0), animated: true })
  }

  /**
   * After a submit failed with "already submitted" (409): the first try may have reached the server
   * with only its answer lost (Wi-Fi dropped). When the check is now done, that was this worker's
   * submission (the server only shows a worker their own checks), so it counts as sent.
   */
  const alreadyDone = async (err: unknown, result: 'COMPLETED' | 'EXCEPTION') => {
    if (!(err instanceof ApiError && err.status === 409)) return null
    try {
      const record = await getCheckRecord(checkId)
      return record.result === result || record.status === result ? record : null
    } catch {
      return null
    }
  }

  const sendCheck = async () => {
    if (!form || sendingRef.current) return
    const perParameter: Record<string, string[]> = {}
    for (const p of parameters) {
      const items = whatIsMissing(p, values[p.id] ?? '', na[p.id] ?? null, media)
      if (items.length) perParameter[p.id] = items
    }
    const overall: string[] = []
    // Same rule as the server: a manually started check does not ask for the PO No.
    if (form.activity.requireJobNo && form.check.submissionType !== 'MANUAL' && !jobNo.trim()) overall.push('PO No.')
    if (!form.check.machineId && !selectedMachineId) overall.push('Machine')
    // A typed Item Code must have the standard format (a job's own Item Code is not typed here).
    if (!form.job && !(form.check.jobId && form.check.jobNo) && itemCodeError(itemCode)) overall.push('Item Code')
    if (form.activity.requirePhoto && !media.photo) overall.push('Check photo')
    if (form.activity.requireVideo && !media.video) overall.push('Check video')

    setMissing(perParameter)
    setMissingOverall(overall)
    if (Object.keys(perParameter).length || overall.length) {
      const first = parameters.find((p) => perParameter[p.id])
      scrollToFirst(overall.length ? null : (first?.id ?? null))
      explainMissing(perParameter, overall)
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

    sendingRef.current = true
    setSending(true)
    setProgress(0)
    try {
      const submitted = await submitCheck(
        checkId,
        {
          itemCode: itemCode.trim(),
          jobNo: jobNo.trim(),
          // Only a check without a machine of its own takes the machine the worker picked.
          machineId: form.check.machineId ? undefined : selectedMachineId,
          values: submitValues,
          media: files
        },
        setProgress
      )
      dropDraft()
      setResult(submitted)
      if (submitted.askContinue && submitted.job) setAskJob(true)
      // Checks may have been cancelled or moved by this submission: rebuild the local alerts.
      getTodayChecks()
        .then(syncLocalAlerts)
        .catch(() => undefined)
    } catch (err) {
      const record = await alreadyDone(err, 'COMPLETED')
      if (record) {
        dropDraft()
        setResult({
          ...record,
          nextDueAt: record.nextDueAt ?? null,
          notApplicableCount: record.values.filter((v) => v.notApplicable).length
        })
        resyncAlerts()
      } else {
        handleError('Could not submit the check', err, sendCheck)
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const resyncAlerts = () =>
    getTodayChecks()
      .then(syncLocalAlerts)
      .catch(() => undefined)

  /**
   * Before submitting: a popup lists what is still needed (each photo and video by parameter
   * name, then readings), with a Close button. The missing items are also marked on their cards.
   */
  const explainMissing = (perParameter: Record<string, string[]>, overall: string[]) => {
    const files: (DialogItem & { target: CameraTarget })[] = []
    const addFile = (mode: 'photo' | 'video', field: string, label: string) =>
      files.push({ label, detail: mode === 'photo' ? 'Photo required' : 'Video required', icon: mode === 'photo' ? 'camera-outline' : 'videocam-outline', target: { mode, field, label } })
    if (overall.includes('Check photo')) addFile('photo', 'photo', 'Check photo')
    if (overall.includes('Check video')) addFile('video', 'video', 'Check video')
    for (const p of parameters) {
      const needs = perParameter[p.id] ?? []
      if (needs.includes('Photo')) addFile('photo', photoField(p.id), p.name)
      if (needs.includes('Video')) addFile('video', videoField(p.id), p.name)
    }
    const readings: DialogItem[] = [
      ...(overall.includes('Machine') ? [{ label: 'Machine', detail: 'Select a machine for this check', icon: 'construct-outline' as const }] : []),
      ...(overall.includes('PO No.') ? [{ label: 'PO No.', detail: 'Enter the job number', icon: 'create-outline' as const }] : []),
      ...(overall.includes('Item Code') ? [{ label: 'Item Code', detail: ITEM_CODE_ERROR, icon: 'create-outline' as const }] : []),
      ...parameters.filter((p) => (perParameter[p.id] ?? []).includes('Value')).map((p) => ({ label: p.name, detail: 'Reading required', icon: 'create-outline' as const }))
    ]
    const photos = files.filter((f) => f.target.mode === 'photo').length
    const videos = files.length - photos
    const count = [photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null, videos ? `${videos} video${videos === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')
    showMissingItems({
      title: !files.length ? 'Some readings are missing' : !videos ? 'Photo required' : !photos ? 'Video required' : 'Photo and video required',
      message: files.length
        ? `This check needs ${count}${readings.length ? ' and the readings below' : ''} before it can be submitted.`
        : 'Fill in these readings before submitting the check.',
      items: [...files.map(({ target: _target, ...item }) => item), ...readings],
      next: files.length ? 'Take each one with the camera. Missing items are also marked in the form.' : 'The missing readings are marked in the form.'
    })
  }

  /** End Job from "Continue or end?": the Job End check opens next; with none, the job is completed. */
  const endJobNow = async () => {
    const job = result?.job
    if (!job || endingRef.current) return
    endingRef.current = true
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
        showSuccess('Job completed', `PO No. ${job.jobNo} is completed.`)
        onClose(true)
      }
    } catch (err) {
      showError(err, { title: 'Could not end the job', onRetry: endJobNow })
    } finally {
      endingRef.current = false
      setEndingJob(false)
    }
  }

  /** The job's next open check for this worker (e.g. another check type's Job Start check), if any. */
  const nextJobCheck = result?.pendingJobChecks?.find((c) => c.id !== checkId && c.canSubmit && (c.kind === 'JOB_START' || c.kind === 'JOB_END'))

  const sendException = async () => {
    if (sendingRef.current) return
    const items: string[] = []
    if (!reason) items.push('Reason')
    if (reason === 'Other' && !remark.trim()) items.push('Remark')
    if (!exceptionPhoto) items.push('Photo')
    // Same rule and wording as the server (backend lib/validate.ts exceptionDetailsError).
    const needMachine = !form?.check.machineId && !selectedMachineId
    const machineProblem = isMachineReason(reason, form?.exceptionReasonRules)
    const needPoItem = !machineProblem && !jobNo.trim() && !itemCode.trim()
    const badItemCode = !machineProblem && !form?.job && !(form?.check.jobId && form?.check.jobNo) && !!itemCodeError(itemCode)
    const detailsMessage =
      needMachine && needPoItem
        ? 'Machine Name and PO No. / Item Code are required for an Exception.'
        : needMachine
        ? 'Machine Name is required for an Exception.'
        : needPoItem
        ? 'PO No. / Item Code is required for an Exception.'
        : badItemCode
        ? ITEM_CODE_ERROR
        : null
    setMissingOverall([...(needMachine ? ['Machine'] : []), ...(needPoItem ? ['PO No. / Item Code'] : []), ...(badItemCode ? ['Item Code'] : [])])
    if (items.length || !reason || !exceptionPhoto || detailsMessage) {
      showMissingItems({
        title: detailsMessage && !items.length ? detailsMessage : !exceptionPhoto && items.length === 1 && !detailsMessage ? 'Photo required' : 'Some details are missing',
        message: detailsMessage ?? 'An exception needs a reason and a photo of the problem before it can be sent.',
        items: [
          ...(needMachine ? [{ label: 'Machine', detail: 'Select the machine', icon: 'construct-outline' as const }] : []),
          ...(needPoItem ? [{ label: 'PO No. / Item Code', detail: 'Enter the PO No. or Item Code', icon: 'create-outline' as const }] : []),
          ...(badItemCode ? [{ label: 'Item Code', detail: ITEM_CODE_ERROR, icon: 'create-outline' as const }] : []),
          ...(!reason ? [{ label: 'Reason', detail: 'Choose why the check could not be done', icon: 'list-outline' as const }] : []),
          ...(reason === 'Other' && !remark.trim() ? [{ label: 'Remark', detail: 'Describe the problem', icon: 'create-outline' as const }] : []),
          ...(!exceptionPhoto ? [{ label: 'Exception photo', detail: 'Photo required', icon: 'camera-outline' as const }] : [])
        ],
        fix: !exceptionPhoto
          ? { text: 'Take Photo', icon: 'camera-outline', onPress: () => setCamera({ mode: 'photo', field: 'exception', label: 'Exception photo' }) }
          : undefined
      })
      return
    }

    sendingRef.current = true
    setSending(true)
    setProgress(0)
    try {
      await submitException(
        checkId,
        {
          reason,
          remark: remark.trim(),
          photo: exceptionPhoto,
          // Not asked for a machine problem, so nothing typed earlier is sent with it.
          itemCode: machineProblem ? '' : itemCode.trim(),
          jobNo: machineProblem ? '' : jobNo.trim(),
          machineId: form?.check.machineId ? undefined : selectedMachineId
        },
        setProgress
      )
      dropDraft()
      showSuccess('Exception recorded', 'The exception has been recorded.', () => onClose(true))
    } catch (err) {
      // The first try may have been recorded with only its answer lost.
      if (await alreadyDone(err, 'EXCEPTION')) {
        dropDraft()
        resyncAlerts()
        showSuccess('Exception recorded', 'The exception has been recorded.', () => onClose(true))
      } else {
        handleError('Could not send the exception', err, sendException)
      }
    } finally {
      sendingRef.current = false
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
  const jobNoMissing = missingOverall.includes('PO No.')
  const machineMissing = missingOverall.includes('Machine')
  const machineDisplayText = selectedMachine
    ? `${selectedMachine.name}${selectedMachine.code ? ` (${selectedMachine.code})` : ''}`
    : ''
  /** The check's own machine: shown, never changed. Only a check without one lets the worker pick. */
  const ownMachineText = check.machineId
    ? `${check.machineName ?? 'Machine'}${check.machineCode ? ` (${check.machineCode})` : ''}`
    : null
  /** A job's check: its Item Code and PO No. are the job's, shown but not typed. */
  const jobFixed = job
    ? { itemCode: job.itemCode ?? '', jobNo: job.jobNo }
    : check.jobId && check.jobNo
    ? { itemCode: check.itemCode ?? '', jobNo: check.jobNo }
    : null
  const detailsHelp = jobFixed
    ? ownMachineText
      ? 'The Item Code, PO No. and machine come from the job.'
      : 'The Item Code and PO No. come from the job. Select the machine for this quality check.'
    : ownMachineText
    ? 'Enter the Item Code and PO No. for this quality check.'
    : 'Enter Item Code, PO No. and select Machine for this quality check.'
  /** Exceptions need the PO No. or the Item Code: either one clears the mark on both. */
  const poItemMissing = missingOverall.includes('PO No. / Item Code')
  const clearPoItem = (key: string) => setMissingOverall((prev) => prev.filter((m) => m !== key && m !== 'PO No. / Item Code'))
  /** Machine stopped / maintenance / breakdown: the exception form asks for the machine only. */
  const machineOnly = mode === 'exception' && isMachineReason(reason, form?.exceptionReasonRules)
  /** The typed Item Code is not in the standard format (marked after a submit attempt). */
  const itemCodeBad = missingOverall.includes('Item Code')

  /**
   * The department the check will be saved with: a typed Item Code's (FGSL -> Sleeve, from Department
   * Configuration), as the server decides on submit; otherwise the check's own. Never chosen by hand.
   */
  const typed = !jobFixed && !machineOnly ? itemCode.trim().toUpperCase() : ''
  const itemDepartment = typed
    ? (form.itemCodeDepartments ?? []).filter((m) => typed.startsWith(m.prefix.toUpperCase())).sort((a, b) => b.prefix.length - a.prefix.length)[0]
    : undefined
  const departmentShown = itemDepartment?.name ?? check.departmentName

  /** Item Code, PO No. and machine: the same rows on the check form and the exception form. */
  const detailsGroup = (
    <>
    <ListGroup>
      {machineOnly ? null : jobFixed ? (
        <LockedRow key="item" label="Item Code" value={jobFixed.itemCode || '—'} note="fixed by the job" />
      ) : (
        <InlineField
          key="item"
          label="Item Code"
          placeholder="Enter Item Code"
          value={itemCode}
          invalid={poItemMissing || itemCodeBad}
          onChangeText={(text) => {
            setItemCode(text)
            clearPoItem('Item Code')
          }}
          maxLength={60}
        />
      )}
      {machineOnly ? null : jobFixed ? (
        <LockedRow key="job" label="PO No." value={jobFixed.jobNo} note="fixed by the job" />
      ) : (
        <InlineField
          key="job"
          label="PO No."
          placeholder="Enter PO No."
          value={jobNo}
          invalid={jobNoMissing || poItemMissing}
          onChangeText={(text) => {
            setJobNo(text)
            clearPoItem('PO No.')
          }}
          maxLength={60}
        />
      )}
      {ownMachineText ? (
        <LockedRow key="machine" label="Machine" value={ownMachineText} note="the machine of this check" />
      ) : (
        <SelectRow
          key="machine"
          label="Machine"
          placeholder="Select Machine"
          value={machineDisplayText}
          invalid={machineMissing}
          onPress={() => setMachineModalOpen(true)}
        />
      )}
      {departmentShown ? (
        <LockedRow key="department" label="Department" value={departmentShown} note={itemDepartment ? 'set from the Item Code' : 'set by the check type'} />
      ) : null}
    </ListGroup>
    {itemCodeBad && !machineOnly ? <Text className="mt-2 px-4 text-[13px] font-medium text-missed">{ITEM_CODE_ERROR}</Text> : null}
    </>
  )

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
          <View className="flex-1">
            <KeyboardAwareScrollView ref={scroller} className="flex-1" contentContainerClassName="px-5 pb-10">
              <View className="pb-6 pt-4">
                <View className="flex-row items-center gap-2 mb-1">
                  <View className={`px-2 py-0.5 rounded border ${check.module === 'QC' ? 'bg-indigo-50 border-indigo-200' : 'bg-blue-50 border-blue-200'}`}>
                    <Text className={`text-[12px] font-bold ${check.module === 'QC' ? 'text-indigo-700' : 'text-blue-700'}`}>
                      {check.module ?? 'IPQC'}
                    </Text>
                  </View>
                  <Text className="text-[14px] font-medium text-ink-muted">
                    {check.departmentName ?? check.machineName ?? ''}
                  </Text>
                </View>
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

              {restoredDraft && check.canSubmit ? (
                <View className="mb-6 flex-row items-start rounded-xl bg-accent-soft px-3 py-2.5" accessibilityLiveRegion="polite">
                  <Icon name="refresh-outline" size={18} color="accent" />
                  <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink">
                    Restored what you typed last time. Check it before you submit. Photos and videos are not kept, so take any again.
                  </Text>
                </View>
              ) : null}

              {!check.canSubmit ? (
                <EmptyState icon="lock-closed-outline" title="This check is closed" message={check.message ?? undefined} />
              ) : (
                <View className="gap-7">
                  <View>
                    <SectionHeader title="Check details" />
                    {detailsGroup}
                    <Text className="mt-2 px-4 text-[13px] text-ink-muted">{detailsHelp}</Text>
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
            </KeyboardAwareScrollView>

            {check.canSubmit && (
              <KeyboardAvoider>
                <ActionBar>
                <Button label={sending ? sendingLabel : 'Submit'} onPress={sendCheck} loading={sending} />
                {sending ? (
                  <View className="mt-3">
                    <ProgressBar done={Math.round(progress * 100)} total={100} />
                  </View>
                ) : null}
                </ActionBar>
              </KeyboardAvoider>
            )}
          </View>
        </>
      ) : (
        <>
          <NavBar leftLabel="Back" onLeftPress={goBack} title="Exception" />
          <View className="flex-1">
            <KeyboardAwareScrollView className="flex-1" contentContainerClassName="px-5 pb-10">
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
                  <SectionHeader title={machineOnly ? 'Machine' : 'Check details'} detail="Required" />
                  {detailsGroup}
                  <Text className="mt-2 px-4 text-[13px] text-ink-muted">
                    {machineOnly
                      ? 'A machine problem: only the machine is needed.'
                      : jobFixed && ownMachineText
                      ? detailsHelp
                      : 'Machine and PO No. or Item Code are required for an exception.'}
                  </Text>
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
            </KeyboardAwareScrollView>

            <KeyboardAvoider>
              <ActionBar>
              <Button label={sending ? sendingLabel : 'Submit Exception'} onPress={sendException} loading={sending} />
              {sending ? (
                <View className="mt-3">
                  <ProgressBar done={Math.round(progress * 100)} total={100} />
                </View>
              ) : null}
              </ActionBar>
            </KeyboardAvoider>
          </View>
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

      <MachinePickerModal
        visible={machineModalOpen}
        machines={machinesList}
        selectedId={selectedMachineId}
        onSelect={(id) => {
          setSelectedMachineId(id)
          setMissingOverall((prev) => prev.filter((m) => m !== 'Machine'))
          setMachineModalOpen(false)
        }}
        onClose={() => setMachineModalOpen(false)}
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
}> = ({ label, placeholder, value, onChangeText, maxLength, invalid = false }) => {
  const reveal = useRevealInput()
  const [focused, setFocused] = useState(false)
  return (
    <View className={`min-h-[56px] flex-row items-center px-4 ${focused ? 'bg-accent-soft' : ''}`}>
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
        onFocus={() => {
          setFocused(true)
          reveal?.()
        }}
        onBlur={() => setFocused(false)}
        // Android centres a fixed-height single-line input only when it is told to; without this
        // the text sits half out of the row and reads as "not visible" while typing.
        textAlignVertical="center"
        cursorColor={ACCENT}
        selectionColor={ACCENT}
        className="h-14 flex-1 py-0 text-right text-[17px] font-medium text-ink"
        // The colour is set here too: a TextInput that misses its class keeps the platform default.
        style={Platform.OS === 'web' ? ({ outlineStyle: 'none', minWidth: 0, color: INK } as object) : { color: INK }}
      />
    </View>
  )
}

/** Tappable row for selecting an option: label on left, value/placeholder on right, chevron. */
const SelectRow: React.FC<{
  label: string
  placeholder: string
  value: string
  invalid?: boolean
  onPress: () => void
}> = ({ label, placeholder, value, invalid = false, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={`${label}: ${value || placeholder}`}
    className="min-h-[56px] flex-row items-center px-4 active:bg-subtle"
  >
    <Text className={`w-[96px] text-[17px] ${invalid ? 'font-semibold text-missed' : 'text-ink'}`}>{label}</Text>
    <Text
      className={`flex-1 text-right text-[17px] ${value ? 'font-medium text-ink' : 'text-ink-muted'}`}
      numberOfLines={1}
    >
      {value || placeholder}
    </Text>
    <View className="ml-2">
      <Icon name="chevron-forward" size={16} color="faint" />
    </View>
  </Pressable>
)

/** Bottom sheet modal for selecting a machine. */
export const MachinePickerModal: React.FC<{
  visible: boolean
  machines: { id: string; name: string; code?: string }[]
  selectedId: string
  onSelect: (machineId: string) => void
  onClose: () => void
}> = ({ visible, machines, selectedId, onSelect, onClose }) => {
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (visible) setSearch('')
  }, [visible])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return machines
    return machines.filter((m) => m.name.toLowerCase().includes(q) || (m.code && m.code.toLowerCase().includes(q)))
  }, [machines, search])

  const sheetHeight = Math.min(Math.max(windowHeight * 0.65, 420), windowHeight * 0.85)

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
        {/* Backdrop tap dismiss */}
        <Pressable
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          onPress={onClose}
          accessible={false}
        />

        <KeyboardAvoider>
          <View
            className="rounded-t-[28px] bg-canvas px-5 pt-3"
            style={{
              height: sheetHeight,
              paddingBottom: Math.max(insets.bottom, 16) + 8
            }}
          >
            {/* Handle */}
            <View className="mb-2 h-1.5 w-10 self-center rounded-full bg-line-strong" />

            {/* Header */}
            <View className="flex-row items-center pb-3">
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                className="h-11 min-w-[72px] justify-center active:opacity-50"
              >
                <Text className="text-[17px] font-medium text-accent">Cancel</Text>
              </Pressable>
              <Text className="flex-1 text-center text-[18px] font-bold text-ink">Select Machine</Text>
              <View className="min-w-[72px]" />
            </View>

            {/* Search filter */}
            {machines.length > 2 && (
              <View className="mb-3 flex-row items-center rounded-xl bg-subtle px-3.5 py-2">
                <Icon name="search-outline" size={18} color="faint" />
                <TextInput
                  placeholder="Search machine name or code..."
                  placeholderTextColor={PLACEHOLDER_COLOR}
                  value={search}
                  onChangeText={setSearch}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  cursorColor={ACCENT}
                  selectionColor={ACCENT}
                  className="ml-2.5 flex-1 py-0 text-[16px] text-ink"
                  style={Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : undefined}
                />
              </View>
            )}

            {/* Scrollable Machine List */}
            <ScrollView
              className="flex-1"
              contentContainerStyle={{ paddingBottom: 24 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={true}
            >
              <ListGroup inset="radio">
                {filtered.map((m) => {
                  const selected = m.id === selectedId
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => onSelect(m.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`${m.name}${m.code ? `, ${m.code}` : ''}`}
                      className={`min-h-[56px] flex-row items-center px-4 py-3 active:bg-subtle ${selected ? 'bg-accent-soft/40' : ''}`}
                    >
                      <RadioMark selected={selected} />
                      <View className="ml-3 flex-1">
                        <Text className={`text-[17px] text-ink ${selected ? 'font-semibold text-accent' : ''}`}>
                          {m.name}
                        </Text>
                        {m.code ? <Text className="mt-0.5 text-[13px] text-ink-muted">{m.code}</Text> : null}
                      </View>
                      {selected ? (
                        <View className="ml-2">
                          <Icon name="checkmark" size={18} color="accent" />
                        </View>
                      ) : null}
                    </Pressable>
                  )
                })}
                {filtered.length === 0 && (
                  <View className="py-12 items-center justify-center">
                    <Icon name="construct-outline" size={32} color="faint" />
                    <Text className="mt-2 px-6 text-center text-[15px] font-medium text-ink-muted">
                      {search ? 'No matching machines' : 'No machines are assigned to your department. Please contact the administrator.'}
                    </Text>
                  </View>
                )}
              </ListGroup>
            </ScrollView>
          </View>
        </KeyboardAvoider>
      </View>
    </Modal>
  )
}

/** A value the worker cannot change here (fixed by the job or the check); `note` says why, for screen readers. */
const LockedRow: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note = 'fixed by the running job' }) => (
  <View className="min-h-[56px] flex-row items-center px-4" accessibilityLabel={`${label} ${value}, ${note}`}>
    <Text className="w-[96px] text-[17px] text-ink">{label}</Text>
    <Text className="flex-1 text-right text-[17px] font-semibold text-ink" numberOfLines={1}>
      {value}
    </Text>
    <View className="ml-2">
      <Icon name="lock-closed" size={15} color="faint" />
    </View>
  </View>
)

/**
 * Whether the reason needs only the machine (no PO No. / Item Code): the Super Admin sets it per reason
 * and the server sends it with the form. A server without that setting is followed by the old name rule.
 */
function isMachineReason(reason: string | null, rules?: { label: string; requiresJobDetails: boolean }[]) {
  if (!reason) return false
  const rule = rules?.find((r) => r.label === reason)
  if (rule) return !rule.requiresJobDetails
  return /machine|maintenance|breakdown/i.test(reason)
}
