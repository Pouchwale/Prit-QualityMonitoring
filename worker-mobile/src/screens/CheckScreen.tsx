import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, BackHandler, KeyboardAvoidingView, Platform } from 'react-native'
import { ApiError, getCheckForm, submitCheck, submitException } from '../services/api'
import { showDialog } from '../utils/dialog'
import { Capture, CheckForm } from '../types'
import { formatTime } from '../utils/format'
import { NavBar } from '../components/ui/NavBar'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { ActionBar } from '../components/ui/ActionBar'
import { Button } from '../components/ui/Button'
import { FieldLabel } from '../components/ui/FieldLabel'
import { TextField } from '../components/ui/TextField'
import { ErrorState, Loading } from '../components/ui/LoadState'
import { ParameterField, numberStatus } from '../components/ParameterField'
import { EvidenceField } from '../components/EvidenceField'
import { CameraModal } from '../components/CameraModal'

interface Props {
  checkId: string
  onClose: (submitted: boolean) => void
  /**
   * How the worker started: "image" opens the camera straight away, "exception" opens the
   * exception form. Without it (e.g. from a notification) the check form is shown.
   */
  startWith?: 'image' | 'exception'
}

type CameraTarget = { mode: 'photo' | 'video'; target: 'check' | 'exception' }

export const CheckScreen: React.FC<Props> = ({ checkId, onClose, startWith }) => {
  const [form, setForm] = useState<CheckForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'check' | 'exception'>(startWith === 'exception' ? 'exception' : 'check')
  const startedCamera = useRef(false)
  const [camera, setCamera] = useState<CameraTarget | null>(null)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState(0)

  // Check form
  const [jobNo, setJobNo] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [photo, setPhoto] = useState<Capture | null>(null)
  const [video, setVideo] = useState<Capture | null>(null)

  // Exception form
  const [reason, setReason] = useState<string | null>(null)
  const [remark, setRemark] = useState('')
  const [exceptionPhoto, setExceptionPhoto] = useState<Capture | null>(null)

  // The form configuration is always loaded fresh, so admin changes apply immediately.
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setForm(await getCheckForm(checkId))
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [checkId])

  useEffect(() => {
    load()
  }, [load])

  // "Click Image": open the camera as soon as the check is ready.
  useEffect(() => {
    if (startWith === 'image' && form?.check.canSubmit && !startedCamera.current) {
      startedCamera.current = true
      setCamera({ mode: 'photo', target: 'check' })
    }
  }, [form, startWith])

  const hasInput = !!(jobNo || photo || video || Object.values(values).some(Boolean) || reason || remark || exceptionPhoto)

  const goBack = useCallback(() => {
    if (sending) return true
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
  }, [hasInput, mode, onClose, sending, startWith])

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

  const sendCheck = async () => {
    if (!form) return
    const missing: string[] = []
    if (form.activity.requireJobNo && !jobNo.trim()) missing.push('Job No.')
    if (form.activity.requirePhoto && !photo) missing.push('Photo')
    if (form.activity.requireVideo && !video) missing.push('Video')
    for (const p of form.parameters) {
      if (p.isRequired && !values[p.id]?.trim()) missing.push(p.name)
    }
    if (missing.length) {
      showDialog('Please complete', missing.join('\n'))
      return
    }

    setSending(true)
    setProgress(0)
    try {
      const result = await submitCheck(
        checkId,
        {
          jobNo: jobNo.trim(),
          values: form.parameters
            .filter((p) => values[p.id]?.trim())
            .map((p) => ({ parameterId: p.id, value: values[p.id].trim() })),
          photo,
          video
        },
        setProgress
      )
      // Status is Completed either way; out-of-range readings are only a note for the worker.
      const outOfRange = form.parameters.some((p) => {
        const raw = values[p.id]?.trim() ?? ''
        return p.type === 'PASS_FAIL' ? raw.toUpperCase() === 'FAIL' : p.type === 'NUMBER' && numberStatus(p, raw) === 'out'
      })
      showDialog(
        'Check submitted',
        outOfRange ? 'Some values are out of range. Your supervisor can see this.' : 'Thank you.',
        [{ text: 'OK', onPress: () => onClose(true) }]
      )
    } catch (err) {
      handleError('Could not submit', err)
    } finally {
      setSending(false)
    }
  }

  const sendException = async () => {
    const missing: string[] = []
    if (!reason) missing.push('Reason')
    if (reason === 'Other' && !remark.trim()) missing.push('Remark')
    if (!exceptionPhoto) missing.push('Photo')
    if (missing.length || !reason || !exceptionPhoto) {
      showDialog('Please complete', missing.join('\n'))
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
    if (camera.target === 'exception') setExceptionPhoto(capture)
    else if (camera.mode === 'photo') setPhoto(capture)
    else setVideo(capture)
    setCamera(null)
  }

  if (!form) {
    return (
      <View className="flex-1 bg-canvas">
        <NavBar leftLabel="‹ Back" onLeftPress={() => onClose(false)} />
        <View className="flex-1 px-5 pt-6">
          {loadError ? <ErrorState message={loadError} onRetry={load} /> : <Loading />}
        </View>
      </View>
    )
  }

  const { check, activity } = form
  const sendingLabel = progress > 0 && progress < 1 ? `Sending… ${Math.round(progress * 100)}%` : 'Sending…'
  const header = (title: string, subtitle: string) => (
    <View className="pb-7 pt-5">
      <Text className="text-[14px] font-semibold uppercase tracking-[0.6px] text-ink-muted">
        {check.machineName}
      </Text>
      <Text className="mt-1 text-[28px] font-bold tracking-[-0.5px] text-ink">{title}</Text>
      <Text className="mt-1 text-[17px] text-ink-secondary">{subtitle}</Text>
    </View>
  )

  return (
    <View className="flex-1 bg-canvas">
      {mode === 'check' ? (
        <>
          <NavBar
            leftLabel="‹ Back"
            onLeftPress={goBack}
            rightLabel={check.canSubmit ? 'Exception' : undefined}
            onRightPress={() => setMode('exception')}
            rightTone="exception"
          />
          <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10" keyboardShouldPersistTaps="handled">
              {header(activity.name, `Due ${formatTime(check.scheduledAt)}`)}

              {!check.canSubmit ? (
                <View className="rounded-xl border border-line bg-surface px-5 py-6">
                  <Text className="text-[18px] font-semibold text-ink">{check.message}</Text>
                </View>
              ) : (
                <View className="gap-7">
                  <View>
                    <FieldLabel label="Job No." required={activity.requireJobNo} />
                    <TextField
                      placeholder="Enter Job No."
                      value={jobNo}
                      onChangeText={setJobNo}
                      autoCapitalize="characters"
                      autoCorrect={false}
                    />
                  </View>

                  <EvidenceField
                    kind="photo"
                    capture={photo}
                    required={activity.requirePhoto}
                    onOpenCamera={() => setCamera({ mode: 'photo', target: 'check' })}
                  />
                  <EvidenceField
                    kind="video"
                    capture={video}
                    required={activity.requireVideo}
                    onOpenCamera={() => setCamera({ mode: 'video', target: 'check' })}
                  />

                  {form.parameters.length > 0 && (
                    <View className="gap-7 border-t border-line pt-7">
                      {form.parameters.map((p) => (
                        <ParameterField
                          key={p.id}
                          parameter={p}
                          value={values[p.id] ?? ''}
                          onChange={(value) => setValues((prev) => ({ ...prev, [p.id]: value }))}
                        />
                      ))}
                    </View>
                  )}
                </View>
              )}
            </ScrollView>

            {check.canSubmit && (
              <ActionBar>
                <Button label={sending ? sendingLabel : 'Submit'} onPress={sendCheck} loading={sending} />
              </ActionBar>
            )}
          </KeyboardAvoidingView>
        </>
      ) : (
        <>
          <NavBar leftLabel="‹ Back" onLeftPress={goBack} title="Exception" />
          <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10" keyboardShouldPersistTaps="handled">
              {header("Can't do this check?", 'Tell us why and take a photo.')}

              <View className="gap-7">
                <View>
                  <SectionHeader title="Reason" />
                  <ListGroup>
                    {form.exceptionReasons.map((r) => {
                      const selected = reason === r
                      return (
                        <Pressable
                          key={r}
                          onPress={() => setReason(r)}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: selected }}
                          className="h-14 flex-row items-center justify-between px-4 active:bg-subtle"
                        >
                          <Text className={`text-[18px] text-ink ${selected ? 'font-semibold' : ''}`}>{r}</Text>
                          {selected ? <Text className="text-[20px] font-bold text-accent">✓</Text> : null}
                        </Pressable>
                      )
                    })}
                  </ListGroup>
                </View>

                <View>
                  <FieldLabel label="Remark" required={reason === 'Other'} />
                  <TextField multiline placeholder="What happened?" value={remark} onChangeText={setRemark} />
                </View>

                <EvidenceField
                  kind="photo"
                  capture={exceptionPhoto}
                  required
                  onOpenCamera={() => setCamera({ mode: 'photo', target: 'exception' })}
                />
              </View>
            </ScrollView>

            <ActionBar>
              <Button label={sending ? sendingLabel : 'Submit Exception'} variant="warning" onPress={sendException} loading={sending} />
            </ActionBar>
          </KeyboardAvoidingView>
        </>
      )}

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
