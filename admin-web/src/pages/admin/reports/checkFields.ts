import type { QualityCheck } from '../../../types'

/** The Item Code / Job No. of a check: its own, or the job's when it recorded none. */
export const itemCodeOf = (c: QualityCheck) => c.itemCode?.trim() || c.job?.itemCode?.trim() || ''
export const jobNoOf = (c: QualityCheck) => c.jobNo?.trim() || c.job?.jobNo?.trim() || ''

/** Pass/Fail and Yes/No readings as words ("Pass", "No"); other readings unchanged. */
export const readingText = (value: string) => (/^(PASS|FAIL|YES|NO)$/.test(value) ? value[0] + value.slice(1).toLowerCase() : value)
