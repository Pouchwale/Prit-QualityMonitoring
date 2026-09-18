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
  /** Module access (from /api/auth/me): what an Admin or Manager may view or manage. */
  permissions?: Record<string, 'none' | 'view' | 'manage'>
  designation: string | null
  departmentName: string | null
  shiftName: string | null
  shiftStartTime: string | null
  shiftEndTime: string | null
}

/** Who started the check: the scheduler (and its alert) or the worker, from the machine screen. */
export type SubmissionType = 'NOTIFICATION' | 'MANUAL'

/** A schedule runs every interval, or only while a job is running on the machine. */
export type ScheduleMode = 'INTERVAL' | 'JOB'

/** How a check type behaves on one machine. MANUAL = no schedule, the worker starts it. */
export type CheckTypeMode = ScheduleMode | 'MANUAL'

/** A parameter that only counts while a job is running is skipped automatically without one. */
export type AppliesWhen = 'ALWAYS' | 'JOB_RUNNING'

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
  itemCode?: string | null
  jobNo: string | null
  submittedAt: string | null
  /** Whether the worker can submit or raise an exception right now. */
  canSubmit: boolean
  message: string | null
  exceptionReason?: string | null
  /** The schedule this check belongs to; null for a check the worker started by hand. */
  scheduleId?: string | null
  submissionType?: SubmissionType | null
  jobId?: string | null
  /** When the next check of this schedule is due, worked out at submission. */
  nextDueAt?: string | null
}

/** A job running on a machine: while it runs, job-based checks are due and record its number. */
export interface Job {
  id: string
  machineId: string
  /** The item being produced, entered with the Job No. when the job started. */
  itemCode?: string | null
  jobNo: string
  startedAt: string
  startedById: string | null
  startedByName: string | null
  endedAt: string | null
}

/** The check a worker can open right now for one check type on one machine. */
export interface OpenCheck {
  id: string
  code: string
  status: QualityCheckStatus
  scheduledAt: string
  windowEndsAt: string
  submissionType: SubmissionType | null
  canSubmit: boolean
  message: string | null
}

export interface CheckTypeSchedule {
  id: string
  shiftId: string | null
  shiftName: string | null
  intervalMinutes: number
  mode: ScheduleMode
  startTime: string | null
  endTime: string | null
}

/** One check type on one machine, with everything the machine screen shows for it. */
export interface MachineCheckType {
  activityId: string
  activityName: string
  activityCode: string
  description: string | null
  /** The worker may start this check without waiting for an alert. */
  allowManual: boolean
  requireJobNo: boolean
  mode: CheckTypeMode
  schedules: CheckTypeSchedule[]
  openCheck: OpenCheck | null
  nextDueAt: string | null
  lastSubmittedAt: string | null
  /** False when a manual start is refused right now; startMessage says why. */
  canStart: boolean
  startMessage: string | null
}

/** A machine assigned to this worker, with its running job and its check types. */
export interface AssignedMachine {
  id: string
  name: string
  code: string
  status: string
  runningJob: Job | null
  /** True when at least one check type on this machine only runs during a job. */
  jobBased: boolean
  checkTypes: MachineCheckType[]
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
  /** Evidence this parameter needs, configured per check type by the admin. */
  requirePhoto: boolean
  requireVideo: boolean
  /** The worker may mark this parameter Not Applicable with a reason. */
  allowNa: boolean
  appliesWhen: AppliesWhen
  /** False when the parameter only counts during a job and no job is running: it is auto N/A. */
  applicable: boolean
  notApplicableReason: string | null
  sortOrder?: number
}

/** A configured reason for marking a parameter Not Applicable. */
export interface NaReason {
  id: string
  label: string
  requiresRemark: boolean
}

export interface CheckForm {
  check: CheckSummary
  activity: {
    id: string
    name: string
    description: string | null
    /** "Overall check photo/video", next to the per-parameter evidence. */
    requirePhoto: boolean
    requireVideo: boolean
    requireJobNo: boolean
    allowManual?: boolean
  }
  parameters: FormParameter[]
  naReasons: NaReason[]
  /** The job running on this machine, if any: its number is prefilled and locked. */
  job: Job | null
  overallEvidence: { photo: boolean; video: boolean }
  exceptionReasons: string[]
  maxVideoSeconds: number
  captureFreshnessMinutes?: number
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
  /** Marked Not Applicable by the worker, or automatically because no job was running. */
  notApplicable?: boolean
  naReason?: string | null
  naRemark?: string | null
  appliesWhen?: AppliesWhen | null
}

export interface MediaFile {
  id: string
  kind: 'PHOTO' | 'VIDEO'
  /** Server path; use fileUrl() to get the full address. */
  url: string
  sizeBytes: number
  durationSeconds: number | null
  capturedAt: string | null
  /** The parameter this evidence belongs to; null for overall check evidence. */
  parameterId?: string | null
}

/** One reading the worker sends, or a parameter marked Not Applicable. */
export interface SubmitValue {
  parameterId: string
  value?: string
  notApplicable?: boolean
  naReasonId?: string | null
  naRemark?: string | null
}

/**
 * One file to send with a check, named after the multipart field the backend expects:
 * `photo:<parameterId>` / `video:<parameterId>` per parameter, `photo` / `video` overall.
 */
export interface EvidenceUpload {
  field: string
  capture: Capture
}

/** What the backend answers after a submission. */
export interface SubmitResult extends CheckSummary {
  nextDueAt: string | null
  notApplicableCount: number
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
