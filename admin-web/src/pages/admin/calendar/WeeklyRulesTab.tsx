import React, { useState } from 'react'
import { CalendarRange, CalendarX2, Lock, Plus, StopCircle, Trash2 } from 'lucide-react'
import type { WeeklyRule } from '../../../types'
import { api, errorText } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { useModuleActions } from '../../../lib/auth'
import { WEEKDAY_NAMES } from '../../../lib/closureTypes'
import { addDaysKey, dateKey, formatDateKey } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { DataState } from '../../../components/common/DataState'
import { Field, FormError, Select, TextInput } from '../../../components/common/Form'
import { Modal } from '../../../components/common/Modal'
import { useToast } from '../../../components/common/Toast'
import { DateInput } from '../../../components/common/DateTimeInputs'
import { Card, CardHeader, EmptyState } from '../../../components/ui/Card'
import { IconButton } from '../../../components/ui/Toolbar'

interface RulesResponse {
  startsOn: string
  earliestChange: string
  rules: WeeklyRule[]
}

const fullDate = (iso: string) => formatDateKey(iso)

type RuleStatus = 'ACTIVE' | 'SCHEDULED' | 'ENDED'
const statusOf = (rule: WeeklyRule, today: string): RuleStatus =>
  rule.effectiveFrom > today ? 'SCHEDULED' : rule.effectiveTo && rule.effectiveTo < today ? 'ENDED' : 'ACTIVE'

const STATUS_STYLE: Record<RuleStatus, { label: string; className: string; dot: string }> = {
  ACTIVE: { label: 'Active', className: 'bg-success-bg text-success ring-success-line', dot: 'bg-[var(--color-chart-completed)]' },
  SCHEDULED: { label: 'Starts later', className: 'bg-due-bg text-due ring-due-line', dot: 'bg-due' },
  ENDED: { label: 'Ended', className: 'bg-subtle text-ink-muted ring-line', dot: 'bg-ink-faint' }
}

// Monday first, like the calendar.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * Recurring weekly closures from 2027. Every change applies from a date that is not in the
 * past, so earlier dates keep the rules that applied to them.
 */
export const WeeklyRulesTab: React.FC = () => {
  const { canCreate, canEdit, canDelete, canWrite } = useModuleActions('calendar')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<RulesResponse>('/api/weekly-rules')
  const legacy = useApi<{ weeklyOffDays: number[] }>('/api/plant-closures/settings')
  const [adding, setAdding] = useState(false)
  const [ending, setEnding] = useState<WeeklyRule | null>(null)
  const [deleting, setDeleting] = useState<WeeklyRule | null>(null)

  const today = dateKey()
  const rules = data?.rules ?? []
  const earliest = data?.earliestChange ?? today
  const removedText = (n: number) => (n ? ` ${n} upcoming check${n === 1 ? ' was' : 's were'} removed from newly closed days.` : '')

  const remove = async () => {
    if (!deleting) return
    try {
      const result = await api.del<{ removedChecks: number }>(`/api/weekly-rules/${deleting.id}`)
      notify('success', 'Weekly rule deleted', `${WEEKDAY_NAMES[deleting.weekday]} closure removed.${removedText(result.removedChecks)}`)
      reload()
    } catch (err) {
      notify('error', 'Could not delete the rule', errorText(err))
    }
  }

  return (
    <div className="space-y-4">
      <DataState loading={loading} error={error} onRetry={reload} empty={data === null ? undefined : false}>
        <Card className="overflow-hidden">
          <CardHeader
            icon={<CalendarRange className="w-4 h-4" />}
            title="Weekly rules"
            subtitle={`Closed weekdays from ${data ? fullDate(data.startsOn) : '01/01/2027'}`}
            info={`The plant is closed on these weekdays from ${data ? fullDate(data.startsOn) : '01/01/2027'} onwards, in every year, unless a date in the annual calendar says otherwise (an Adjustment Working Day opens it).`}
            actions={
              canCreate && (
                <Button size="sm" variant="primary" onClick={() => setAdding(true)} icon={<Plus className="w-3.5 h-3.5" />}>
                  Add weekly rule
                </Button>
              )
            }
          />
          {rules.length === 0 ? (
            <EmptyState icon={<CalendarX2 className="w-5 h-5" />} title="No weekly rules" hint="From 2027 the plant is open every day unless a date is marked closed." compact />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Closed every</th>
                    <th>From</th>
                    <th>Until</th>
                    <th>Status</th>
                    <th>Note</th>
                    {canWrite && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => {
                    const status = statusOf(rule, today)
                    const started = rule.effectiveFrom < earliest
                    const day = WEEKDAY_NAMES[rule.weekday]
                    return (
                      <tr key={rule.id}>
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-2 font-semibold text-ink">
                            <span className="w-7 h-7 rounded-md bg-subtle ring-1 ring-inset ring-line text-[11px] font-semibold text-ink-secondary flex items-center justify-center" aria-hidden>
                              {day.slice(0, 3)}
                            </span>
                            {day}
                          </span>
                        </td>
                        <td className="whitespace-nowrap tabular-nums">{fullDate(rule.effectiveFrom)}</td>
                        <td className="whitespace-nowrap tabular-nums">{rule.effectiveTo ? fullDate(rule.effectiveTo) : <span className="text-ink-muted">No end date</span>}</td>
                        <td className="whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 h-5 px-1.5 rounded-full ring-1 ring-inset text-[11px] font-medium ${STATUS_STYLE[status].className}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLE[status].dot}`} aria-hidden />
                            {STATUS_STYLE[status].label}
                          </span>
                        </td>
                        <td className="text-ink-secondary">{rule.note || <span className="text-ink-faint">—</span>}</td>
                        {canWrite && (
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex items-center gap-0.5">
                              {canEdit && status !== 'ENDED' && (
                                <IconButton label={rule.effectiveTo ? `Change end of the ${day} rule` : `End the ${day} rule`} onClick={() => setEnding(rule)}>
                                  <StopCircle className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                              {canDelete && !started && (
                                <IconButton label={`Delete the ${day} rule`} tone="danger" onClick={() => setDeleting(rule)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </IconButton>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </DataState>

      <div className="flex items-start gap-3 px-4 py-3 rounded-[10px] border border-line bg-subtle/60 text-[12.5px] text-ink-secondary">
        <span className="w-7 h-7 shrink-0 rounded-md bg-white ring-1 ring-inset ring-line text-ink-muted flex items-center justify-center" aria-hidden>
          <Lock className="w-3.5 h-3.5" />
        </span>
        <div>
          <div className="font-semibold text-ink">Up to 31/12/2026</div>
          <div>
            {legacy.data
              ? legacy.data.weeklyOffDays.length
                ? `Closed every ${legacy.data.weeklyOffDays.map((d) => WEEKDAY_NAMES[d]).join(' and ')}, with the 2026 holidays and adjustment working days as they are.`
                : 'No weekly off.'
              : 'Loading…'}{' '}
            This is locked so 2026 check statuses, Missed counts and reports never change.
          </div>
        </div>
      </div>

      {adding && (
        <RuleModal
          earliest={earliest}
          onClose={() => setAdding(false)}
          onSaved={(removed, rule) => {
            setAdding(false)
            reload()
            notify('success', 'Weekly rule added', `Closed every ${WEEKDAY_NAMES[rule.weekday]} from ${fullDate(rule.effectiveFrom)}.${removedText(removed)}`)
          }}
        />
      )}
      {ending && (
        <EndRuleModal
          rule={ending}
          earliest={earliest}
          onClose={() => setEnding(null)}
          onSaved={(removed, rule) => {
            setEnding(null)
            reload()
            notify(
              'success',
              rule.effectiveTo ? 'Weekly rule ends' : 'Weekly rule has no end date',
              rule.effectiveTo
                ? `The last closed ${WEEKDAY_NAMES[rule.weekday]} is ${fullDate(rule.effectiveTo)}. Later ${WEEKDAY_NAMES[rule.weekday]}s are working days.${removedText(removed)}`
                : `Every ${WEEKDAY_NAMES[rule.weekday]} stays closed.${removedText(removed)}`
            )
          }}
        />
      )}
      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete this weekly rule?"
        message={deleting && `The ${WEEKDAY_NAMES[deleting.weekday]} closure from ${fullDate(deleting.effectiveFrom)} has not started yet, so it is removed completely.`}
        confirmLabel="Delete rule"
        danger
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

const RuleModal: React.FC<{ earliest: string; onClose: () => void; onSaved: (removedChecks: number, rule: WeeklyRule) => void }> = ({ earliest, onClose, onSaved }) => {
  const [weekday, setWeekday] = useState(4)
  const [from, setFrom] = useState(earliest)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await api.post<{ rule: WeeklyRule; removedChecks: number }>('/api/weekly-rules', {
        weekday,
        effectiveFrom: from,
        effectiveTo: to || null,
        note: note.trim() || null
      })
      onSaved(result.removedChecks, result.rule)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Add weekly rule"
      subtitle="The plant is closed on this weekday between the dates"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="rule-form" variant="primary" loading={saving} icon={<CalendarRange className="w-3.5 h-3.5" />}>
            Add rule
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Closed every" required>
          <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAY_ORDER.map((d) => (
              <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="From" required hint={`${fullDate(earliest)} at the earliest`}>
            <DateInput value={from} min={earliest} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
          <Field label="Until" hint="Leave empty for no end date">
            <DateInput value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Field label="Note" hint="Optional">
          <TextInput value={note} maxLength={200} placeholder="e.g. Weekly off" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

const EndRuleModal: React.FC<{ rule: WeeklyRule; earliest: string; onClose: () => void; onSaved: (removedChecks: number, rule: WeeklyRule) => void }> = ({
  rule,
  earliest,
  onClose,
  onSaved
}) => {
  const lastAllowed = addDaysKey(earliest, -1)
  const minEnd = rule.effectiveFrom > lastAllowed ? rule.effectiveFrom : lastAllowed
  const [to, setTo] = useState(rule.effectiveTo ?? minEnd)
  const [openEnded, setOpenEnded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await api.put<{ rule: WeeklyRule; removedChecks: number }>(`/api/weekly-rules/${rule.id}`, { effectiveTo: openEnded ? null : to })
      onSaved(result.removedChecks, result.rule)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`End the ${WEEKDAY_NAMES[rule.weekday]} rule`}
      subtitle={`Started ${fullDate(rule.effectiveFrom)}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="end-rule-form" variant="primary" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id="end-rule-form" onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label={`Last closed ${WEEKDAY_NAMES[rule.weekday]} on or before`} required hint={`${fullDate(minEnd)} at the earliest — dates already passed keep this rule`}>
          <DateInput value={to} min={minEnd} disabled={openEnded} onChange={(e) => setTo(e.target.value)} required={!openEnded} />
        </Field>
        {rule.effectiveTo && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink">
            <input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Remove the end date (keep the rule going)
          </label>
        )}
      </form>
    </Modal>
  )
}
