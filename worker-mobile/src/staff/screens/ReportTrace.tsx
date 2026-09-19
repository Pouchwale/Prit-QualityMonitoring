import React, { useState } from 'react'
import { Text, View } from 'react-native'
import type { QualityCheck, TraceChange, TraceGroup, TraceReport, TraceWorker } from '../types'
import { formatDateTime, plural } from '../format'
import { Badge, List, ListFooterLink, MetricCard, MiniStat, Notice, Row, Section, StatusBadge } from '../ui'

// Same sections as the web panel's Reports (admin-web/src/pages/admin/reports/TraceSections.tsx).

/** The Item Code / Job No. of a check: its own, or the job's when it recorded none. */
export const itemCodeOf = (c: QualityCheck) => c.itemCode?.trim() || c.job?.itemCode?.trim() || ''
export const jobNoOf = (c: QualityCheck) => c.jobNo?.trim() || c.job?.jobNo?.trim() || ''
/** Pass/Fail and Yes/No readings as words ("Pass", "No"); other readings unchanged. */
const readingText = (value: string) => (/^(PASS|FAIL|YES|NO)$/.test(value) ? value[0] + value.slice(1).toLowerCase() : value)
const doerOf = (c: QualityCheck) => c.submittedByName ?? c.workerName ?? 'Unassigned'
const list = (values: string[]) => values.filter(Boolean).join(', ') || 'None'
const SHOWN = 5

/** A list that shows the first few rows and a "Show all" link. */
function Rows<T>({ items, render, noun }: { items: T[]; render: (item: T, index: number) => React.ReactNode; noun: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, SHOWN)
  return (
    <List>
      {shown.map(render)}
      {items.length > SHOWN ? (
        <ListFooterLink
          label={all ? 'Show less' : `Show all ${items.length}`}
          accessibilityLabel={all ? `Show fewer ${noun}` : `Show all ${items.length} ${noun}`}
          icon={all ? 'chevron-up' : 'chevron-down'}
          onPress={() => setAll((v) => !v)}
        />
      ) : null}
    </List>
  )
}

const groupDetail = (g: TraceGroup) =>
  [
    `${g.readings} readings${g.outsideLimits ? `, ${g.outsideLimits} outside limits` : ''}`,
    `${plural(g.changes, 'change')}, ${plural(g.corrections, 'correction')}`,
    `Workers: ${list(g.workers)}`,
    `Machines: ${list(g.machines)}`,
    g.firstAt ? `${formatDateTime(g.firstAt)} – ${formatDateTime(g.lastAt)}` : null
  ]
    .filter(Boolean)
    .join('\n')

const groupBadge = (g: TraceGroup) =>
  g.missed ? <Badge label={`${g.missed} missed`} tone="missed" /> : g.exceptions ? <Badge label={plural(g.exceptions, 'exception')} tone="exception" /> : null

const changeLabel = (ch: TraceChange) => (ch.correction ? 'Correction' : ch.wentOutside ? 'Went outside limits' : 'Change')

/** Traceability for an Item Code, Job No. or worker report. */
export const TraceBlock: React.FC<{
  trace: TraceReport
  scope: string
  onPickItem: (itemCode: string) => void
  onPickJob: (jobNo: string) => void
}> = ({ trace, scope, onPickItem, onPickJob }) => {
  const c = trace.counts
  return (
    <>
      <MetricCard
        label={`Traceability: ${scope}`}
        value={c.checks}
        suffix={c.checks === 1 ? 'time checked' : 'times checked'}
        caption={`${c.completed} completed · ${c.missed} missed · ${plural(c.exceptions, 'exception')} · ${c.readings} readings (${c.outsideLimits} outside limits)`}
      >
        <MiniStat label="Changes" value={c.changes} tone="neutral" />
        <MiniStat label="Corrected" value={c.corrections} tone="success" accessibilityLabel={`${c.corrections} corrections`} />
        <MiniStat label="Items" value={trace.items.filter((i) => i.key).length} tone="neutral" accessibilityLabel="Item Codes" />
        <MiniStat label="Jobs" value={trace.jobs.filter((j) => j.key).length} tone="neutral" accessibilityLabel="Job Nos." />
      </MetricCard>

      <Section title="Item Codes" detail="Times checked, jobs, workers and machines per item">
        <Rows
          items={trace.items}
          noun="item codes"
          render={(g) => (
            <Row
              key={g.key || '—'}
              title={g.key || 'No Item Code'}
              subtitle={`${plural(g.checks, 'check')} · ${g.completed} completed · Job Nos. ${list(g.jobNos)}`}
              subtitleLines={2}
              detail={groupDetail(g)}
              detailLines={5}
              right={groupBadge(g)}
              accessibilityLabel={g.key ? `Item Code ${g.key}` : 'No Item Code'}
              onPress={g.key ? () => onPickItem(g.key) : undefined}
            />
          )}
        />
      </Section>

      <Section title="Job Nos." detail="Item codes, checks, workers and machines per job">
        <Rows
          items={trace.jobs}
          noun="job numbers"
          render={(g) => (
            <Row
              key={g.key || '—'}
              title={g.key ? `Job No. ${g.key}` : 'No Job No.'}
              subtitle={`${plural(g.checks, 'check')} · ${g.completed} completed · Item Codes ${list(g.itemCodes)}`}
              subtitleLines={2}
              detail={groupDetail(g)}
              detailLines={5}
              right={groupBadge(g)}
              onPress={g.key ? () => onPickJob(g.key) : undefined}
            />
          )}
        />
      </Section>

      <Section title="Worker activity" detail="Every Item Code each worker checked">
        <Rows
          items={trace.workers}
          noun="workers"
          render={(w: TraceWorker) => (
            <Row
              key={w.workerId ?? w.name}
              title={`${w.name}${w.employeeId ? ` · ${w.employeeId}` : ''}`}
              subtitle={`${plural(w.checks, 'check')} · ${w.completed} completed · ${w.missed} missed · ${plural(w.exceptions, 'exception')} · ${plural(w.changes, 'change')}`}
              subtitleLines={2}
              detail={w.items.map((i) => `${i.itemCode || 'No Item Code'}: ${plural(i.checks, 'check')} · Job ${list(i.jobNos)}`).join('\n')}
              detailLines={12}
            />
          )}
        />
      </Section>

      <Section title="Changes and corrections" detail="Readings that differ from the previous reading of the same parameter, item, job and machine">
        {trace.changes.length === 0 ? (
          <Notice title="No reading changed in this period." />
        ) : (
          <Rows
            items={trace.changes}
            noun="changes"
            render={(ch, i) => (
              <Row
                key={`${ch.checkId}-${ch.parameterName}-${i}`}
                title={`${ch.parameterName}: ${readingText(ch.from)} → ${readingText(ch.to)}${ch.unit ? ` ${ch.unit}` : ''}`}
                subtitle={`${formatDateTime(ch.at)} · ${ch.machineName} · by ${ch.byName}`}
                subtitleLines={2}
                detail={`Item ${ch.itemCode || 'none'} · Job ${ch.jobNo || 'none'}\n${ch.fromResult} → ${ch.toResult} · previous by ${ch.previousByName}, ${formatDateTime(ch.previousAt)}`}
                detailLines={3}
                right={<Badge label={changeLabel(ch)} tone={ch.correction ? 'success' : ch.wentOutside ? 'missed' : 'neutral'} />}
              />
            )}
          />
        )}
      </Section>
    </>
  )
}

/** Every check with all its readings, who did it and any exception. */
export const DetailedRecords: React.FC<{ checks: QualityCheck[]; onOpen: (id: string) => void }> = ({ checks, onOpen }) => (
  <Section title="Detailed records" detail={`${plural(checks.length, 'check')} with every reading`}>
    {checks.length === 0 ? (
      <Notice title="No records." />
    ) : (
      <Rows
        items={checks}
        noun="records"
        render={(c) => {
          const readings = c.values
            .map((v) => `${v.parameterName}: ${v.notApplicable ? `N/A${v.naReason ? ` (${v.naReason})` : ''}` : v.value ? `${readingText(v.value)}${v.unit ? ` ${v.unit}` : ''}${v.result === 'FAIL' ? ' (outside limits)' : ''}` : '—'}`)
            .join('\n')
          const exception = c.exception
            ? `Exception: ${[c.exception.reason, c.exception.remark].filter(Boolean).join(' — ')} · ${c.exception.status}${c.exception.reviewedByName ? ` by ${c.exception.reviewedByName}` : ''}`
            : c.result === 'MISSED'
              ? `Missed: not submitted before ${formatDateTime(c.windowEndsAt)}`
              : null
          return (
            <Row
              key={c.id}
              title={`${c.machineName} · ${formatDateTime(c.submittedAt ?? c.scheduledAt)}`}
              subtitle={`Item ${itemCodeOf(c) || 'none'} · Job ${jobNoOf(c) || 'none'} · ${doerOf(c)}`}
              subtitleLines={2}
              detail={[readings, exception].filter(Boolean).join('\n') || null}
              detailLines={40}
              right={c.result ? <StatusBadge status={c.result} /> : <Badge label="Open" />}
              accessibilityLabel={`${c.machineName}, ${formatDateTime(c.submittedAt ?? c.scheduledAt)}`}
              onPress={() => onOpen(c.id)}
            />
          )
        }}
      />
    )}
  </Section>
)

export const TraceError: React.FC<{ message: string }> = ({ message }) => (
  <View>
    <Text className="text-[14px] text-missed">Could not load the traceability sections: {message}</Text>
  </View>
)
