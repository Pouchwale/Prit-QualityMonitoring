export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL'

export type QualityCheckStatus =
  | 'PENDING'
  | 'DUE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'MISSED'
  | 'EXCEPTION'

export interface Profile {
  id: string
  name: string
  employeeId: string
  role: 'WORKER' | 'MANAGER' | 'ADMIN' | 'SUPER_ADMIN'
  designation: string | null
  departmentName: string | null
  shiftName: string | null
  shiftStartTime: string | null
  shiftEndTime: string | null
}

export interface CheckSummary {
  id: string
  code: string
  machineId: string
  machineName: string
  machineCode: string
  departmentName: string | null
  activityName: string
  scheduledAt: string
  windowEndsAt: string
  status: QualityCheckStatus
  /** Overall result: Completed, Missed or Exception; null while the check is still open. */
  result: 'COMPLETED' | 'MISSED' | 'EXCEPTION' | null
  jobNo: string | null
  submittedAt: string | null
  /** Whether the worker can submit or raise an exception right now. */
  canSubmit: boolean
  message: string | null
  exceptionReason?: string | null
}

export interface FormParameter {
  id: string
  name: string
  type: ParameterType
  unit: string | null
  minValue: number | null
  maxValue: number | null
  options: string[]
  description: string | null
  isRequired: boolean
  rule: string | null
}

export interface CheckForm {
  check: CheckSummary
  activity: {
    id: string
    name: string
    description: string | null
    requirePhoto: boolean
    requireVideo: boolean
    requireJobNo: boolean
  }
  parameters: FormParameter[]
  exceptionReasons: string[]
  maxVideoSeconds: number
}

/** A photo or video taken with the camera in this session. */
export interface Capture {
  uri: string
  capturedAt: string
  durationSeconds?: number
  /** Web app only: the captured file itself (the uri is a blob: URL for previews). */
  blob?: Blob
  mimeType?: string
}

export type ValueResult = 'PASS' | 'FAIL' | 'NA'

export interface SubmittedValue {
  parameterId: string | null
  parameterName: string
  parameterType: ParameterType
  unit: string | null
  rule: string | null
  value: string | null
  result: ValueResult
}

export interface MediaFile {
  id: string
  kind: 'PHOTO' | 'VIDEO'
  /** Server path; use fileUrl() to get the full address. */
  url: string
  sizeBytes: number
  durationSeconds: number | null
  capturedAt: string | null
}

export interface ExceptionInfo {
  id: string
  reason: string
  remark: string | null
  status: 'UNDER_REVIEW' | 'ACKNOWLEDGED' | 'ACTION_TAKEN' | 'RESOLVED'
  resolutionNotes: string | null
  createdAt: string
  media: MediaFile[]
}

/** One row in the history list. */
export interface HistoryItem extends CheckSummary {
  exceptionReason: string | null
  photoUrl: string | null
  hasVideo: boolean
  valueCount: number
}

export interface HistoryPage {
  items: HistoryItem[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface HistoryQuery {
  page?: number
  pageSize?: number
  /** YYYY-MM-DD, inclusive. */
  from?: string
  to?: string
  machineId?: string
  departmentId?: string
  kind?: 'ALL' | 'CHECK' | 'EXCEPTION'
}

export interface HistoryFilterOptions {
  machines: { id: string; name: string }[]
  departments: { id: string; name: string }[]
}

/** A submitted record with everything the worker sent. */
export interface CheckRecord extends CheckSummary {
  shiftName: string | null
  values: SubmittedValue[]
  media: MediaFile[]
  exception: ExceptionInfo | null
  submittedByName: string | null
}
