import { Platform } from 'react-native'
import { getApiUrl } from '../services/api'
import { shareText } from '../services/files'
import { PARAMETER_TYPE_LABEL, RESULT_LABEL, checkStatusLabel, formatDateTime } from './format'
import type { QualityCheck } from './types'

/**
 * Print for a quality check: the same "Quality Check Record" the web panel prints from its check
 * detail page (check information, parameter values with their evidence, overall evidence and the
 * exception).
 *
 * The app has no print module, so the record is built as an HTML page: in the browser (worker web
 * app) it opens the print dialog; on a phone it goes to the share sheet, from where it can be
 * printed, saved as PDF or sent. Evidence links are signed and expire, like every evidence link.
 */

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : esc(v))
const mediaSrc = (url: string) => (/^https?:\/\//.test(url) ? url : `${getApiUrl()}${url}`)

function evidence(media: QualityCheck['media']) {
  if (!media.length) return '<p class="muted">No evidence.</p>'
  return `<div class="media">${media
    .map((m) =>
      m.kind === 'PHOTO'
        ? `<figure><img src="${esc(mediaSrc(m.url))}" alt="Photo"/><figcaption>Photo${m.capturedAt ? ` · ${esc(formatDateTime(m.capturedAt))}` : ''}</figcaption></figure>`
        : `<figure><div class="video">Video${m.durationSeconds ? ` · ${Math.round(m.durationSeconds)} s` : ''}</div><figcaption><a href="${esc(mediaSrc(m.url))}">Open video</a>${m.capturedAt ? ` · ${esc(formatDateTime(m.capturedAt))}` : ''}</figcaption></figure>`
    )
    .join('')}</div>`
}

export function checkRecordHtml(check: QualityCheck) {
  const itemCode = check.itemCode ?? check.job?.itemCode ?? null
  const jobNo = check.jobNo ?? check.job?.jobNo ?? null
  const info: [string, unknown][] = [
    ['Machine', `${check.machineName}${check.machineCode ? ` (${check.machineCode})` : ''}`],
    ['Department', check.departmentName],
    ['Check type', check.activityName],
    ['Shift', check.shiftName],
    ['Scheduled at', formatDateTime(check.scheduledAt)],
    ['Window ends', formatDateTime(check.windowEndsAt)],
    ['Assigned worker', check.workerName ? `${check.workerName}${check.workerEmployeeId ? ` (${check.workerEmployeeId})` : ''}` : null],
    ['Submitted by', check.submittedByName ? `${check.submittedByName}${check.submittedByEmployeeId ? ` (${check.submittedByEmployeeId})` : ''}` : null],
    ['Submitted at', check.submittedAt ? formatDateTime(check.submittedAt) : null],
    ['Item Code', itemCode],
    ['PO No.', jobNo],
    ['Submission', check.submissionType === 'MANUAL' ? 'Manual' : 'Notification'],
    ['Next check due', check.nextDueAt ? formatDateTime(check.nextDueAt) : null],
    ['Device', check.deviceInfo]
  ]
  const values = check.values
    .map((v) => {
      const media = v.parameterId ? check.media.filter((m) => m.parameterId === v.parameterId) : []
      const reading = v.notApplicable
        ? `Not applicable: ${esc(v.naReason ?? 'no reason')}${v.naRemark ? ` (${esc(v.naRemark)})` : ''}`
        : v.value !== null && v.value !== ''
          ? `${esc(v.value)}${v.unit ? ` ${esc(v.unit)}` : ''}`
          : '—'
      const within = v.notApplicable ? '' : v.result === 'PASS' ? 'Within limits' : v.result === 'FAIL' ? 'Outside limits' : 'No limit'
      return `<tr><td><b>${esc(v.parameterName)}</b><br/><span class="muted">${esc(PARAMETER_TYPE_LABEL[v.parameterType])}${v.rule ? ` · ${esc(v.rule)}` : ''}</span></td><td>${reading}</td><td class="${v.result === 'FAIL' ? 'bad' : ''}">${within}</td></tr>${
        media.length ? `<tr><td colspan="3">${evidence(media)}</td></tr>` : ''
      }`
    })
    .join('')
  const overall = check.media.filter((m) => !m.parameterId)
  const exc = check.exception
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Quality Check ${esc(check.code)}</title>
<style>
body{font:13px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1d1f;margin:24px;}
h1{font-size:17px;margin:0;text-transform:uppercase;letter-spacing:.02em}
h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid #d2d2d7;padding-bottom:4px}
.muted{color:#6e6e73}.bad{color:#c1271d;font-weight:600}
.head{border-bottom:2px solid #1d1d1f;padding-bottom:8px}
dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 20px;margin:0}
dt{color:#6e6e73;font-size:11px}dd{margin:0;font-weight:500}
table{width:100%;border-collapse:collapse}td{border-bottom:1px solid #e5e5ea;padding:6px 4px;vertical-align:top}
.media{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:170px}img{width:170px;height:128px;object-fit:cover;border:1px solid #d2d2d7}
.video{width:170px;height:128px;display:flex;align-items:center;justify-content:center;background:#f2f2f7;border:1px solid #d2d2d7}
figcaption{font-size:11px;color:#6e6e73}
@media print{body{margin:12mm}a{color:inherit}}
</style></head><body>
<div class="head"><h1>Quality Check Record</h1>
<div>${esc(check.code)} · ${esc(checkStatusLabel(check.status) || check.status)}${check.result ? ` · Result: ${esc(RESULT_LABEL[check.result])}` : ''} · printed ${esc(formatDateTime(new Date().toISOString()))}</div></div>
<h2>Check information</h2><dl>${info.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${dash(v)}</dd></div>`).join('')}</dl>
<h2>Parameter values</h2>${check.values.length ? `<table>${values}</table>` : '<p class="muted">No parameter values were submitted for this check.</p>'}
<h2>Overall evidence</h2>${evidence(overall)}
${
  exc
    ? `<h2>Exception</h2><dl>${(
        [
          ['Status', exc.status],
          ['Reason', exc.reason],
          ['Raised at', formatDateTime(exc.createdAt)],
          ['Reviewed by', exc.reviewedByName],
          ['Worker remark', exc.remark],
          ['Resolution notes', exc.resolutionNotes]
        ] as [string, unknown][]
      )
        .map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${dash(v)}</dd></div>`)
        .join('')}</dl>${evidence(exc.media)}`
    : ''
}
</body></html>`
}

/** Opens the print dialog (browser) or the share sheet (phone) with the check's record. */
export async function printCheck(check: QualityCheck) {
  const html = checkRecordHtml(check)
  if (Platform.OS === 'web') {
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.setAttribute('aria-hidden', 'true')
    document.body.appendChild(frame)
    const doc = frame.contentWindow!.document
    doc.open()
    doc.write(html)
    doc.close()
    // Give the photos a moment to load before the dialog opens.
    setTimeout(() => {
      frame.contentWindow!.focus()
      frame.contentWindow!.print()
      setTimeout(() => frame.remove(), 60_000)
    }, 600)
    return
  }
  await shareText(`quality-check_${check.code}.html`, html, 'text/html')
}
