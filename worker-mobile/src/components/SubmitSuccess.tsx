import React from 'react'
import { View, Text, ScrollView } from 'react-native'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SubmitResult } from '../types'
import { formatTime } from '../utils/format'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { ActionBar } from './ui/ActionBar'
import { ListGroup } from './ui/ListGroup'

interface Props {
  result: SubmitResult
  /** The check type, so the worker sees what was sent. */
  activityName: string
  /** True when a reading was outside its limits; the check is still completed. */
  outOfRange: boolean
  onDone: () => void
  /** Replaces "Done", e.g. "Next: Job Start check". */
  doneLabel?: string
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View className="min-h-[52px] flex-row items-center justify-between px-4 py-3">
    <Text className="text-[16px] text-ink-muted">{label}</Text>
    <Text className="ml-4 flex-1 text-right text-[16px] font-medium text-ink" numberOfLines={2}>
      {value}
    </Text>
  </View>
)

/** Shown after a submission: a calm confirmation, when the next check is due and what was sent. */
export const SubmitSuccess: React.FC<Props> = ({ result, activityName, outOfRange, onDone, doneLabel }) => {
  const insets = useSafeAreaInsets()
  const nextDue = result.nextDueAt ? formatTime(result.nextDueAt) : null

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10">
        <View className="items-center pb-8 pt-12">
          {/* Entering animations follow the system "reduce motion" setting (ReduceMotion.System). */}
          <Animated.View entering={ZoomIn.duration(240)}>
            <View className="h-20 w-20 items-center justify-center rounded-full bg-success">
              <Icon name="checkmark" size={46} color="white" />
            </View>
          </Animated.View>
          <Animated.View entering={FadeIn.duration(250).delay(120)} style={{ alignItems: 'center' }}>
            <Text className="mt-5 text-[28px] font-bold leading-[34px] tracking-[-0.5px] text-ink" accessibilityRole="header">
              {result.jobCompleted ? 'Job completed' : 'Check submitted'}
            </Text>
            <Text className="mt-1 text-center text-[17px] text-ink-secondary">
              {result.machineName} · {activityName}
            </Text>
          </Animated.View>
        </View>

        <Animated.View entering={FadeIn.duration(250).delay(200)} style={{ gap: 28 }}>
          {result.jobActivated ? (
            <View className="flex-row items-start rounded-2xl bg-success-bg px-4 py-3.5">
              <Icon name="play-circle-outline" size={20} color="success" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-secondary">
                Job No. {result.job?.jobNo} is running. The scheduled checks follow the admin's plan.
              </Text>
            </View>
          ) : null}
          {result.jobCompleted ? (
            <View className="flex-row items-start rounded-2xl bg-success-bg px-4 py-3.5">
              <Icon name="checkmark-done-outline" size={20} color="success" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-secondary">
                The Job End check is in and Job No. {result.job?.jobNo} is completed.
              </Text>
            </View>
          ) : null}
          {result.jobCompleted ? null : nextDue ? (
            <View className="items-center rounded-2xl bg-surface px-4 py-5">
              <Text className="text-[15px] font-medium text-ink-muted">Next check due</Text>
              <Text className="mt-0.5 text-[34px] font-bold leading-[40px] tracking-[-0.6px] text-ink">{nextDue}</Text>
              <Text className="mt-1 text-center text-[14px] text-ink-muted">You get an alert when it is due.</Text>
            </View>
          ) : (
            <Text className="text-center text-[15px] text-ink-muted">No further checks scheduled</Text>
          )}

          {outOfRange ? (
            <View className="flex-row items-start rounded-2xl bg-exception-bg px-4 py-3.5">
              <Icon name="alert-circle-outline" size={20} color="exception" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink-secondary">
                Some values are out of range. Your supervisor can see this.
              </Text>
            </View>
          ) : null}

          <View>
            <Text className="mb-2 px-4 text-[15px] font-semibold text-ink-muted">Details</Text>
            <ListGroup>
              <Row label="Check" value={result.code} />
              <Row label="Sent at" value={result.submittedAt ? formatTime(result.submittedAt) : formatTime(new Date().toISOString())} />
              <Row label="Started by" value={result.submissionType === 'MANUAL' ? 'Manual' : 'Notification'} />
              {result.itemCode ? <Row label="Item Code" value={result.itemCode} /> : null}
              {result.jobNo ? <Row label="Job No." value={result.jobNo} /> : null}
              {result.notApplicableCount > 0 ? (
                <Row
                  label="Not applicable"
                  value={`${result.notApplicableCount} ${result.notApplicableCount === 1 ? 'parameter' : 'parameters'}`}
                />
              ) : null}
            </ListGroup>
          </View>
        </Animated.View>
      </ScrollView>

      <ActionBar>
        <Button label={doneLabel ?? 'Done'} onPress={onDone} />
      </ActionBar>
    </View>
  )
}
