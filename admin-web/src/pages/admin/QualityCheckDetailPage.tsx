import React, { useState } from 'react'
import { AlertTriangle, ArrowLeft, Briefcase, Camera, ClipboardCheck, Clock3, Cpu, ListChecks, Printer, RefreshCw, Trash2, User as UserIcon } from 'lucide-react'
import type { CheckResult, MediaFile, QualityCheck } from '../../types'
import { useApi } from '../../lib/useApi'
import { useAuth } from '../../lib/auth'
import { PARAMETER_TYPE_LABEL, formatDateTime, RESULT_HINT, RESULT_LABEL } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { DataState } from '../../components/common/DataState'
import { CheckStatusBadge, StatusBadge } from '../../components/common/StatusBadge'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'
import { DeleteRecordsModal } from '../../components/common/DeleteRecordsModal'
import { useToast } from '../../components/common/Toast'
import { useDeletePermissions } from '../../lib/deletePermissions'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'

interface QualityCheckDetailPageProps {
  checkId: string
  onBack: () => void
}

/** How the check was started. */
const SUBMISSION_LABEL = { MANUAL: 'Manual', NOTIFICATION: 'Notification' } as const

/**
 * Evidence grouped the way the worker captured it: one group per parameter (in form order),
 * then the overall check evidence (media with no parameter, including older checks).
 */
function evidenceGroups(check: QualityCheck): { key: string; label?: string; media: MediaFile[] }[] {
  const groups: { key: string; label?: string; media: MediaFile[] }[] = []
  for (const v of check.values) {
    if (!v.parameterId) continue
    const media = check.media.filter((m) => m.parameterId === v.parameterId)
    if (media.length > 0) groups.push({ key: v.parameterId, label: v.parameterName, media })
  }
  const overall = check.media.filter((m) => !m.parameterId)
  // Evidence of a parameter that is no longer on the form still belongs somewhere.
  const grouped = new Set(groups.map((g) => g.key))
  for (const m of check.media) {
    if (!m.parameterId || grouped.has(m.parameterId)) continue
    grouped.add(m.parameterId)
    groups.push({ key: m.parameterId, label: 'Removed parameter', media: check.media.filter((x) => x.parameterId === m.parameterId) })
  }
  if (overall.length > 0) groups.push({ key: 'overall', label: 'Overall evidence', media: overall })
  // Nothing at all: one empty viewer, with its usual "Live camera evidence" heading.
  if (groups.length === 0) groups.push({ key: 'overall', media: [] })
  return groups
}

export const QualityCheckDetailPage: React.FC<QualityCheckDetailPageProps> = ({ checkId, onBack }) => {
  const { data: check, error, loading, reload } = useApi<QualityCheck>(`/api/quality-checks/${checkId}`)
  // Permanent delete: needs Delete Checks (checked again by the server).
  const canDeleteChecks = useDeletePermissions().DELETE_CHECKS
  // Printing is an export: it needs the Export Reports module.
  const canExport = useAuth().can('export')
  const [deleting, setDeleting] = useState(false)
  const notify = useToast()

  const itemCode = check ? (check.itemCode ?? check.job?.itemCode ?? null) : null
  const jobNo = check ? (check.jobNo ?? check.job?.jobNo ?? null) : null
  const naCount = check?.values.filter((v) => v.notApplicable).length ?? 0
  const failCount = check?.values.filter((v) => !v.notApplicable && v.result === 'FAIL').length ?? 0

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="space-y-3 no-print">
        <Button size="sm" variant="ghost" onClick={onBack} icon={<ArrowLeft className="w-3.5 h-3.5" />} className="-ml-2">
          Back
        </Button>
        <PageHeader
          icon={<ClipboardCheck className="w-4.5 h-4.5" />}
          title={check?.code ?? 'Quality check'}
          description={
            check ? (
              <span className="inline-flex items-center gap-x-2 gap-y-1 flex-wrap">
                <CheckStatusBadge status={check.status} size="sm" />
                {check.result && check.result !== check.status && <ResultBadge result={check.result} size="sm" />}
                <span>
                  {[check.machineName, check.activityName].filter(Boolean).join(' · ')} · scheduled {formatDateTime(check.scheduledAt)}
                </span>
              </span>
            ) : undefined
          }
          actions={
            <>
              <IconButton label="Refresh" size="md" onClick={() => reload()} className="border border-line-strong bg-white">
                <RefreshCw className={`w-4 h-4 ${loading && check !== null ? 'animate-spin' : ''}`} />
              </IconButton>
              {canExport && (
                <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!check} icon={<Printer className="w-3.5 h-3.5" />}>
                  Print
                </Button>
              )}
              {canDeleteChecks && (
                <Button size="sm" variant="outline" onClick={() => setDeleting(true)} disabled={!check} icon={<Trash2 className="w-3.5 h-3.5 text-failed" />}>
                  Delete
                </Button>
              )}
            </>
          }
        />
      </div>
      <DeleteRecordsModal
        type={deleting ? 'checks' : null}
        ids={[checkId]}
        onClose={() => setDeleting(false)}
        onDeleted={(r) => {
          notify('success', 'Check deleted', `${r.filesRemoved} evidence file${r.filesRemoved === 1 ? '' : 's'} removed. Recorded in the audit log.`)
          onBack()
        }}
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={check === null ? undefined : false}>
        {check && (
          <>
            {/* Print-only heading */}
            <div className="hidden print:block border-b border-ink pb-2">
              <h2 className="text-base font-bold uppercase">Quality Check Record</h2>
              <p className="text-xs font-mono">
                {check.code} · {check.status}
                {check.result ? ` · Result: ${RESULT_LABEL[check.result]}` : ''} · printed {formatDateTime(new Date().toISOString())}
              </p>
            </div>

            {/* Summary: what was checked, by whom and for which job. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <SummaryTile
                icon={<Cpu className="w-4 h-4" />}
                label="Machine"
                value={check.machineName}
                detail={[check.machineCode, check.departmentName].filter(Boolean).join(' · ') || null}
              />
              <SummaryTile icon={<ListChecks className="w-4 h-4" />} label="Check type" value={check.activityName} detail={check.shiftName ? `Shift · ${check.shiftName}` : 'No shift'} />
              <SummaryTile
                icon={<UserIcon className="w-4 h-4" />}
                label="Assigned worker"
                value={check.workerName}
                detail={check.workerEmployeeId}
              />
              <SummaryTile
                icon={<Briefcase className="w-4 h-4" />}
                label="PO No. / Item Code"
                value={jobNo}
                detail={itemCode ? `Item ${itemCode}` : 'No Item Code'}
                mono
              />
            </div>

            <Card className="printable-card">
              <CardHeader icon={<Clock3 className="w-4 h-4" />} title="Timing & submission" subtitle={check.submissionType ? `Started from ${check.submissionType === 'MANUAL' ? 'the worker app' : 'a due notification'}` : 'Not submitted'} />
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3.5 p-4">
                <Info label="Scheduled at" value={formatDateTime(check.scheduledAt)} />
                <Info label="Window ends" value={formatDateTime(check.windowEndsAt)} />
                <Info
                  label="Submitted by"
                  value={check.submittedByName}
                  detail={[check.submittedByEmployeeId, check.submittedAt ? formatDateTime(check.submittedAt) : null].filter(Boolean).join(' · ') || null}
                />
                <Info
                  label="Submission"
                  value={check.submissionType ? SUBMISSION_LABEL[check.submissionType] : null}
                  detail={check.submissionType === 'MANUAL' ? 'Started by the worker' : check.submissionType ? 'From a due notification' : null}
                />
                <Info label="Next check due" value={check.nextDueAt ? formatDateTime(check.nextDueAt) : null} />
                <Info label="Department" value={check.departmentName} />
                <Info label="Device" value={check.deviceInfo} className="col-span-2" />
              </dl>
            </Card>

            {check.exception && (
              <Card className="printable-card overflow-hidden border-exception-line">
                <CardHeader
                  icon={<AlertTriangle className="w-4 h-4 text-exception" />}
                  title="Exception raised"
                  subtitle={`Raised ${formatDateTime(check.exception.createdAt)}`}
                  actions={<StatusBadge status={check.exception.status} size="sm" />}
                  className="bg-exception-bg/60 border-exception-line"
                />
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3.5 p-4">
                  <Info label="Reason" value={check.exception.reason} className="col-span-2" />
                  <Info label="Raised at" value={formatDateTime(check.exception.createdAt)} />
                  <Info label="Reviewed by" value={check.exception.reviewedByName} />
                  <Info label="Worker remark" value={check.exception.remark} className="col-span-2" multiline />
                  <Info label="Resolution notes" value={check.exception.resolutionNotes} className="col-span-2" multiline />
                </dl>
                <div className="px-4 pb-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted mb-1.5">Exception photo</div>
                  <EvidenceViewer media={check.exception.media} workerName={check.submittedByName ?? check.workerName} />
                </div>
              </Card>
            )}

            <Card className="overflow-hidden printable-card">
              <CardHeader
                icon={<ListChecks className="w-4 h-4" />}
                title="Parameter readings"
                subtitle={[
                  `${check.values.length} ${check.values.length === 1 ? 'parameter' : 'parameters'}`,
                  failCount > 0 ? `${failCount} outside limits` : null,
                  naCount > 0 ? `${naCount} not applicable` : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
                info={`Values entered by the worker against the configured acceptance rules. Not applicable parameters are never counted as a failure. ${RESULT_HINT}`}
                actions={check.result ? <ResultBadge result={check.result} size="sm" /> : undefined}
              />
              {check.values.length === 0 ? (
                <EmptyState icon={<ListChecks className="w-5 h-5" />} title="No parameter values were submitted for this check." compact />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table stack-sm">
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th>Value</th>
                        <th>Rule</th>
                        <th>Reading</th>
                        <th>Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.values.map((v, i) => {
                        const evidence = v.parameterId ? check.media.filter((m) => m.parameterId === v.parameterId) : []
                        return (
                          <tr key={v.parameterId ?? i} className={v.result === 'FAIL' ? 'bg-missed-bg/40' : undefined}>
                            <td>
                              <div className="font-semibold text-ink">{v.parameterName}</div>
                              <div className="text-[11.5px] text-ink-muted">{PARAMETER_TYPE_LABEL[v.parameterType]}</div>
                            </td>
                            <td>
                              {v.notApplicable ? (
                                <span className="text-ink-secondary">
                                  {v.naReason ?? 'No reason given'}
                                  {v.naRemark && <span className="block text-[11.5px] text-ink-muted">{v.naRemark}</span>}
                                </span>
                              ) : v.value !== null && v.value !== '' ? (
                                <span className="font-mono">
                                  <span className="font-semibold text-ink">{v.value}</span>
                                  {v.unit && <span className="text-ink-muted ml-1">{v.unit}</span>}
                                </span>
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                            <td className="text-ink-secondary">{v.rule ?? '—'}</td>
                            <td className="whitespace-nowrap">
                              {v.notApplicable ? (
                                <span className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded-full ring-1 ring-inset ring-line-strong bg-white text-[11px] font-medium text-ink-muted">
                                  <span className="w-1.5 h-1.5 rounded-full border border-ink-faint" aria-hidden />
                                  Not applicable
                                </span>
                              ) : v.value !== null && v.value !== '' ? (
                                <StatusBadge status={v.result} size="sm" />
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                            <td>{evidence.length > 0 ? <EvidenceViewer media={evidence} compact /> : <span className="text-ink-faint">—</span>}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* One block per parameter that has evidence, then the overall check evidence. */}
            <Card className="printable-card">
              <CardHeader
                icon={<Camera className="w-4 h-4" />}
                title="Evidence"
                subtitle={check.media.length > 0 ? `${check.media.length} ${check.media.length === 1 ? 'file' : 'files'} · captured live in the app` : 'Nothing attached'}
              />
              <div className="p-4 space-y-3">
                {evidenceGroups(check).map((group) => (
                  <EvidenceViewer
                    key={group.key}
                    label={group.label}
                    media={group.media}
                    workerName={check.submittedByName ?? check.workerName}
                    deviceInfo={check.deviceInfo}
                  />
                ))}
              </div>
            </Card>
          </>
        )}
      </DataState>
    </div>
  )
}

/** One fact of the summary row: icon tile, label, value and a muted detail line. */
const SummaryTile: React.FC<{ icon: React.ReactNode; label: string; value: string | null | undefined; detail?: string | null; mono?: boolean }> = ({
  icon,
  label,
  value,
  detail,
  mono
}) => (
  <div className="card p-3.5 min-w-0 flex items-start gap-3 printable-card">
    <span className="w-8 h-8 shrink-0 rounded-md bg-subtle text-ink-secondary flex items-center justify-center" aria-hidden>
      {icon}
    </span>
    <div className="min-w-0">
      <div className="text-[11.5px] font-medium text-ink-muted">{label}</div>
      <div className={`text-[14px] font-semibold truncate ${value ? 'text-ink' : 'text-ink-faint'} ${mono ? 'font-mono' : ''}`} title={value ?? undefined}>
        {value || '—'}
      </div>
      {detail && <div className={`text-[11.5px] text-ink-muted truncate ${mono ? 'font-mono' : ''}`}>{detail}</div>}
    </div>
  </div>
)

const Info: React.FC<{
  label: string
  value: string | null | undefined
  detail?: string | null
  multiline?: boolean
  className?: string
}> = ({ label, value, detail, multiline, className = '' }) => (
  <div className={`min-w-0 ${className}`}>
    <dt className="text-[11.5px] text-ink-muted">{label}</dt>
    <dd
      className={`mt-0.5 text-[13px] font-medium tabular-nums ${value ? 'text-ink' : 'text-ink-faint'} ${multiline ? 'whitespace-pre-wrap' : 'truncate'}`}
      title={multiline ? undefined : (value ?? undefined)}
    >
      {value || '—'}
    </dd>
    {detail && <dd className="text-[11.5px] text-ink-muted truncate">{detail}</dd>}
  </div>
)

/** Overall result: Completed, Missed or Exception. */
const ResultBadge: React.FC<{ result: CheckResult; size?: 'sm' | 'md' }> = ({ result, size = 'md' }) => (
  <span className="inline-flex items-center gap-1">
    <span className="text-[11px] text-ink-muted">Result</span>
    <StatusBadge status={result} size={size} showDot={false} />
  </span>
)
