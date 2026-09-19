export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL' | 'PHOTO'

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

/** SCHEDULED: a shift schedule check. JOB_*: a job's start check, interval check or end check. */
export type CheckKind = 'SCHEDULED' | 'JOB_START' | 'JOB_INTERVAL' | 'JOB_END'

/** PLANNED → STARTING (Job Start check) → ACTIVE → ENDING (Job End check) → COMPLETED. */
export type JobStatus = 'PLANNED' | 'STARTING' | 'ACTIVE' | 'ENDING' | 'COMPLETED' | 'CANCELLED'

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
  /** Older servers leave it out: a shift schedule check. */
  kind?: CheckKind
}

/** A production job on a machine: planned, starting, running, ending or finished. */
export interface Job {
  id: string
  machineId: string
  /** The item being produced, entered with the Job No. when the job started. */
  itemCode?: string | null
  jobNo: string
  /** Older servers leave it out: a job that is running. */
  status?: JobStatus
  startedAt: string | null
  startedById: string | null
  startedByName: string | null
  activatedAt?: string | null
  endRequestedAt?: string | null
  endedAt: string | null
  /** The worker responsible now: the job's checks and notifications go to them. */
  assignedWorkerId?: string | null
  assignedWorkerName?: string | null
  plannedFor?: string | null
  note?: string | null
}

/** One of the running job's checks for this worker (Job Start, Job End or the next interval check). */
export interface JobCheck {
  id: string
  code: string
  kind: CheckKind
  activityId: string
  status: QualityCheckStatus
  scheduledAt: string
  windowEndsAt: string
  /** Exactly the parameters this check asks for. */
  parameterNames: string[]
  canSubmit: boolean
  message: string | null
}

/** What a job-based check type asks at job start, at each interval and at job end. */
export interface JobPlan {
  activityId: string
  name: string
  start: string[]
  intervals: { minutes: number; parameters: string[] }[]
  end: string[]
}

/** The check a worker can open right now for one check type on one machine. */
export interface OpenCheck {
  id: string
  code: string
  status: QualityCheckStatus
  scheduledAt: string
  windowEndsAt: string
  submissionType: SubmissionType | null
  kind?: CheckKind
  /** A job check lists the parameters it asks for. */
  parameterNames?: string[]
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
  /** JOB: checked per job (start, intervals, end), with only the parameters that are due. */
  monitoring?: 'SHIFT' | 'JOB'
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
  /** False when the plant is closed today or a machine day plan leaves this machine out (older servers omit it). */
  runsToday?: boolean
  /** Why the machine does not run today; null when it runs. */
  notRunning?: MachineNotRunning | null
  /** The running job's checks for this worker: Job Start, Job End and the next interval check. */
  jobChecks?: JobCheck[]
  /** Jobs planned for this machine that this worker may start. */
  plannedJobs?: Job[]
  /** The job-based check types and when their parameters are checked. */
  jobPlan?: JobPlan[]
}

/** Why a machine does not run today: the plant is closed, or a machine day plan leaves it out (planned). */
export interface MachineNotRunning {
  label: string
  reason: string | null
  planned: boolean
  message: string
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
  /** False for Job Start / Job End checks: they cannot be skipped with an exception. */
  allowException?: boolean
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
  /** Job checks: the job after this submission. */
  job?: Job | null
  jobActivated?: boolean
  jobCompleted?: boolean
  /** Ask "Continue the job or end the job?" (after a scheduled job check). */
  askContinue?: boolean
  /** The job's checks still open for this worker. */
  pendingJobChecks?: CheckSummary[]
}

/** A job's handover from one worker to another. */
export interface JobHandover {
  id: string
  at: string
  fromName: string | null
  toName: string | null
  byName: string | null
  shiftName: string | null
  note: string | null
  movedChecks: number
}

/** A job with its handovers, this worker's open checks and the checks already done. */
export interface JobDetail {
  job: Job
  machine: { name: string; code: string } | null
  handovers: JobHandover[]
  open: CheckSummary[]
  history: (CheckSummary & {
    workerName: string | null
    values: { parameterName: string; value: string | null; unit: string | null; result: string | null; notApplicable: boolean; naReason: string | null }[]
    exception: { reason: string; remark: string | null } | null
  })[]
}

export interface HandoverOptions {
  shifts: { id: string; name: string; startTime: string; endTime: string }[]
  workers: { id: string; name: string; employeeId: string; shiftId: string | null }[]
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
