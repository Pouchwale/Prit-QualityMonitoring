import React from 'react'
import { View, Text } from 'react-native'
import { JobCheck, JobCheckPlan, JobStatus, PlanItem } from '../types'
import { formatTime } from '../utils/format'
import { Button } from './ui/Button'
import { Icon, IconName, IconColor } from './ui/Icon'

interface Props {
  plan: JobCheckPlan
  /** The running job's status; null before Start Job (a preview of the plan). */
  status: JobStatus | null
  /** The running job's open checks for this worker (Job Start, Job End, next interval check). */
  checks?: JobCheck[]
  /** False when the job is with another worker: the plan is shown, without its buttons. */
  canAct?: boolean
  onOpenCheck?: (checkId: string) => void
}

/** Timing labels in the worker's words. */
const everyLabel = (minutes: number) =>
  minutes % 60 === 0 ? `EVERY ${minutes / 60 === 1 ? '60 MIN' : `${minutes / 60} HOURS`}` : `EVERY ${minutes} MIN`

/** "BEFORE JOB START", "EVERY 30 MIN", "AT JOB END". */
const SectionLabel: React.FC<{ text: string }> = ({ text }) => (
  <Text className="mb-1.5 text-[13px] font-semibold tracking-[0.4px] text-ink-muted">{text}</Text>
)

/** One check of the plan: a state icon, its name, and "Optional" when no reading is required. */
const ItemRow: React.FC<{ item: PlanItem; icon: IconName; color: IconColor; showType: boolean }> = ({ item, icon, color, showType }) => (
  <View className="flex-row items-center py-1" accessible accessibilityLabel={`${item.name}${item.required ? '' : ', optional'}`}>
    <Icon name={icon} size={18} color={color} />
    <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink" numberOfLines={2}>
      {item.name}
      {showType ? <Text className="text-ink-muted"> · {item.checkType}</Text> : null}
    </Text>
    {!item.required ? <Text className="ml-2 text-[13px] text-ink-muted">Optional</Text> : null}
  </View>
)

/** A compact card for one timing group, with its status line and an optional action. */
const PlanCard: React.FC<{ status: string; tone?: string; children: React.ReactNode; action?: React.ReactNode }> = ({ status, tone = 'text-ink-muted', children, action }) => (
  <View className="rounded-xl border border-line px-3 py-2.5">
    {children}
    <Text className={`mt-1.5 text-[14px] font-medium ${tone}`}>{status}</Text>
    {action}
  </View>
)

/**
 * The job's check plan: what is checked before the job starts, every N minutes while it runs, and
 * at job end. Everything comes from the server (the department's check type configuration); this
 * only lays it out. Before Start Job it is a preview; on a running job it shows what is done, due
 * and next, and opens the open pre-start, interval or job end check.
 */
export const CheckPlan: React.FC<Props> = ({ plan, status, checks = [], canAct = true, onOpenCheck }) => {
  // Name the check type next to each check only when the department has more than one.
  const showType = plan.checkTypes.length > 1
  const startChecks = checks.filter((c) => c.kind === 'JOB_START')
  const endChecks = checks.filter((c) => c.kind === 'JOB_END')
  const started = status === 'ACTIVE' || status === 'ENDING' || status === 'COMPLETED'
  const ending = status === 'ENDING' || status === 'COMPLETED'

  const openButtons = (open: JobCheck[], label: string) =>
    canAct && onOpenCheck
      ? open.map((c, i) => (
          <Button
            key={c.id}
            label={open.length > 1 ? `${label} ${i + 1}` : label}
            icon="clipboard-outline"
            size="compact"
            onPress={() => onOpenCheck(c.id)}
            disabled={!c.canSubmit}
            className="mt-2.5"
          />
        ))
      : null

  return (
    <View className="gap-4">
      {/* Before job start */}
      <View>
        <SectionLabel text="BEFORE JOB START" />
        {plan.beforeStart.length === 0 ? (
          <Text className="text-[15px] text-ink-muted">No pre-start checks are set up. The job starts at once.</Text>
        ) : started ? (
          <View className="flex-row items-center rounded-xl border border-line px-3 py-2.5">
            <Icon name="checkmark-circle" size={18} color="success" />
            <Text className="ml-2 flex-1 text-[15px] font-medium text-success">
              {plan.beforeStart.length} pre-start {plan.beforeStart.length === 1 ? 'check' : 'checks'} completed
            </Text>
          </View>
        ) : (
          <PlanCard
            status={status === 'STARTING' ? 'Pending: the job starts once these are submitted.' : 'Pending: done first, before the job starts.'}
            tone={status === 'STARTING' ? 'text-due' : 'text-ink-muted'}
            action={status === 'STARTING' ? openButtons(startChecks, 'Complete Pre-Start Check') : null}
          >
            {plan.beforeStart.map((item) => (
              <ItemRow key={item.parameterId} item={item} icon="ellipse-outline" color="faint" showType={showType} />
            ))}
          </PlanCard>
        )}
      </View>

      {/* During the job, every N minutes */}
      <View>
        <SectionLabel text="DURING JOB" />
        {plan.intervals.length === 0 ? (
          <Text className="text-[15px] text-ink-muted">No checks are set up during the job.</Text>
        ) : (
          <View className="gap-2">
            {plan.intervals.map((group) => {
              const names = new Set(group.items.map((i) => i.name))
              // Due (or being filled in) now; the next check is planned ahead as PENDING, which is not due yet.
              const open = checks.find((c) => c.kind === 'JOB_INTERVAL' && c.canSubmit && c.status !== 'PENDING' && c.parameterNames.some((n) => names.has(n)))
              const state = ending
                ? { text: 'Stopped: the job is ending.', tone: 'text-ink-muted' }
                : !started
                  ? { text: 'Starts after the pre-start checks.', tone: 'text-ink-muted' }
                  : open
                    ? { text: 'Due now', tone: 'text-due' }
                    : group.nextDueAt
                      ? { text: `Next due ${formatTime(group.nextDueAt)}`, tone: 'text-ink-secondary' }
                      : { text: 'Scheduled', tone: 'text-ink-muted' }
              return (
                <PlanCard
                  key={group.minutes}
                  status={state.text}
                  tone={state.tone}
                  action={open && canAct && onOpenCheck ? (
                    <Button label="Complete Check" icon="clipboard-outline" size="compact" onPress={() => onOpenCheck(open.id)} className="mt-2.5" />
                  ) : null}
                >
                  <View className="mb-1 flex-row items-center">
                    <Icon name="repeat-outline" size={16} color="accent" />
                    <Text className="ml-1.5 text-[13px] font-semibold tracking-[0.4px] text-accent">{everyLabel(group.minutes)}</Text>
                  </View>
                  {group.items.map((item) => (
                    <ItemRow key={item.parameterId} item={item} icon="ellipse" color="faint" showType={showType} />
                  ))}
                </PlanCard>
              )
            })}
          </View>
        )}
      </View>

      {/* At job end */}
      <View>
        <SectionLabel text="AT JOB END" />
        {plan.atEnd.length === 0 ? (
          <Text className="text-[15px] text-ink-muted">No job end checks are set up. The job completes when you end it.</Text>
        ) : (
          <PlanCard
            status={ending ? 'Pending: the job completes once these are submitted.' : 'When you end the job.'}
            tone={ending ? 'text-due' : 'text-ink-muted'}
            action={ending ? openButtons(endChecks, 'Complete Job End Check') : null}
          >
            {plan.atEnd.map((item) => (
              <ItemRow key={item.parameterId} item={item} icon={ending ? 'ellipse-outline' : 'flag-outline'} color="faint" showType={showType} />
            ))}
          </PlanCard>
        )}
      </View>
    </View>
  )
}
