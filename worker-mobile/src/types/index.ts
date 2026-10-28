export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL' | 'PHOTO'

export type QualityCheckStatus =
  | 'PENDING'
  | 'DUE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'MISSED'
  | 'EXCEPTION'

export type WorkerQualityRole = 'IPQC' | 'QC' | 'BOTH'

export interface Profile {
  id: string
  name: string
  employeeId: string
  role: 'WORKER' | 'MANAGER' | 'ADMIN' | 'SUPER_ADMIN'
  workerQualityRole?: WorkerQualityRole
  /** Module access (from /api/auth/me): what an Admin or Manager may view or manage. */
  permissions?: Record<string, 'none' | 'view' | 'manage'>
  designation: string | null
  departmentName: string | null
  shiftName: string | null
  shiftStartTime: string | null
  shiftEndTime: string | null
  /** The language voice alerts are spoken in (the worker's choice); notifications are always English. */
  voiceNotificationLanguage?: VoiceLanguage
  /**
   * Workers with a shift: when the server ends this sign-in (the end of the shift, ISO time). The
   * app signs out then; null when the sign-in is not tied to a shift.
   */
  sessionEndsAt?: string | null
  /**
   * What the user may do, per module and action (view, create, edit, …). For a worker: the app
   * features the Super Admin set for the Worker role (app_jobs, app_performance, app_history).
   * Missing from older servers.
   */
  actions?: Record<string, Record<string, boolean>>
}

/** Voice alert languages: English, Hindi, Gujarati. */
export type VoiceLanguage = 'en' | 'hi' | 'gu'

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
  machineId?: string | null
  machineName?: string | null
  machineCode?: string | null
  departmentName: string | null
  activityName: string
  module?: 'IPQC' | 'QC'
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
  /** The exception's reading, e.g. "Viscosity: 21.5 sec". */
  exceptionReading?: string | null
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
  /** The item being produced, entered with the PO No.; it decides the job's department. */
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
  /**
   * The job's department (Pouch, Sleeve, Label), worked out by the server from the Item Code. On a
   * planned job it is the one found when it was planned; Start Job works it out again.
   */
  departmentId?: string | null
  departmentName?: string | null
}

/** One check of a job's check plan (a parameter of a job check type), e.g. "Viscosity". */
export interface PlanItem {
  parameterId: string
  name: string
  /** The reading must be entered (otherwise it is optional). */
  required: boolean
  /** The check type it belongs to. */
  checkType: string
}

/**
 * What a job's checks ask and when, from the admin's check type configuration (the server builds
 * it; nothing about a department is written in the app).
 */
export interface JobCheckPlan {
  checkTypes: { activityId: string; name: string; graceMinutes: number }[]
  /** Checked before the job starts: the job waits for them. */
  beforeStart: PlanItem[]
  /** Due every `minutes` while the job runs; `nextDueAt` only for a running (active) job. */
  intervals: { minutes: number; items: PlanItem[]; nextDueAt?: string | null }[]
  /** Checked when the job is ended. */
  atEnd: PlanItem[]
}

/** The plan of a job before Start Job: the department its Item Code names, and its checks. */
export interface JobPlanPreview {
  itemCode: string
  department: { id: string; code: string; name: string }
  plan: JobCheckPlan
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
  /** The running job's check plan (older servers leave it out). */
  checkPlan?: JobCheckPlan | null
  /** Jobs planned for this machine that this worker may start. */
  plannedJobs?: Job[]
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
  /** Dropdown only: a first choice (the material) made before the options. Absent on an older server. */
  materialOptions?: string[]
  /** Dropdown only: the worker may choose several options. Absent on an older server. */
  multiSelect?: boolean
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
  /** Which reasons need the PO No. / Item Code as well as the machine (set by the Super Admin). Older servers leave it out. */
  exceptionReasonRules?: ExceptionReasonRule[]
  /** Active Item Code prefixes and their departments (Department Configuration); absent on older servers. */
  itemCodeDepartments?: { prefix: string; name: string }[]
  maxVideoSeconds: number
  captureFreshnessMinutes?: number
  machines?: { id: string; name: string; code?: string }[]
}

/** A photo or video taken with the camera in this session. */
/** "My performance": this worker's own figures, calculated by the backend. */
export interface MyPerformance {
  /** Checks whose time is over in the period: finished, or past the end of their window. */
  assigned: number
  completed: number
  /** Checks the worker missed: the only ones that lower the score. */
  missed: number
  /** Same as `missed`, still sent by the server for older app builds. */
  missedChecks?: number
  /** Exceptions raised: they count as done. */
  exceptions: number
  /** Checks still open inside their window: not counted yet. */
  open: number
  /** Completion % minus 100 (exceptions count as done): 0 when nothing was missed. */
  score: number
  /** (completed + exceptions) / assigned, as a percentage. */
  completionRate: number
}

/** What an exception reason asks for (set in the admin panel). Older servers send only some fields. */
export interface ExceptionReasonRule {
  label: string
  requiresJobDetails: boolean
  requiresRemark?: boolean
  photoEvidence?: 'OFF' | 'OPTIONAL' | 'REQUIRED'
  videoEvidence?: 'OFF' | 'OPTIONAL' | 'REQUIRED'
  /** A reading the worker must enter with this reason (e.g. "Viscosity"), and its unit; null: none. */
  readingLabel?: string | null
  readingUnit?: string | null
}

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
    exception: { reason: string; remark: string | null; reading?: string | null } | null
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
  /** The reading the reason asked for, e.g. "Viscosity: 21.5 sec". */
  reading?: string | null
  status: 'UNDER_REVIEW' | 'ACKNOWLEDGED' | 'ACTION_TAKEN' | 'RESOLVED'
  resolutionNotes: string | null
  createdAt: string
  media: MediaFile[]
}

/** One row in the history list. */
export interface HistoryItem extends CheckSummary {
  exceptionReason: string | null
  exceptionReading?: string | null
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

/** One day (or the whole week) of the worker's own weekly report (GET /api/worker/performance/weekly). */
export interface WeekDayScore {
  assigned: number
  /** Completed + exceptions. */
  done: number
  completed: number
  exceptions: number
  missed: number
  pending: number
  /** Completion % minus 100; null on a day with no checks counted. */
  score: number | null
}

/** This worker's own overall score, from their first check up to today. */
export interface MyOverall {
  asOf: string
  /** The plant date of the worker's first check, or null when they have none yet. */
  since: string | null
  overall: WeekDayScore | null
}

export interface MyWeek {
  weekStart: string
  /** Sunday to Saturday, YYYY-MM-DD. */
  dates: string[]
  days: WeekDayScore[]
  week: WeekDayScore | null
}

// ---------------------------------------------------------------------------- Leave (backend services/leave.ts)

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type DayPart = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF'

export interface LeaveTypeOption {
  id: string
  name: string
  code: string
  isPaid: boolean
  allowHalfDay: boolean
  requiresAttachment: boolean
  /** The employee types the leave's own name (Custom Leave). */
  isCustom?: boolean
  advanceNoticeDays: number
  maxConsecutiveDays: number | null
  /** Days per leave year; null: no limit. */
  quota: number | null
}

export interface LeaveBalance {
  leaveTypeId: string
  name: string
  code: string
  isPaid: boolean
  quota: number | null
  carriedForward: number
  allocated: number | null
  used: number
  pending: number
  remaining: number | null
}

interface MyRequestBase {
  id: string
  startDate: string
  endDate: string
  reason: string
  status: LeaveStatus
  hasAttachment: boolean
  attachmentName: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionComment: string | null
  createdAt: string
}

export interface MyLeaveRequest extends MyRequestBase {
  leaveTypeId: string
  leaveTypeName: string
  leaveTypeCode: string
  dayPart: DayPart
  dayPartLabel: string
  days: number
}

export interface MyShiftChange extends MyRequestBase {
  currentShiftName: string | null
  requestedShiftId: string
  requestedShiftName: string
  requestedShiftTime: string
}

export interface LeaveOverview {
  year: { start: string; end: string; label: string }
  types: LeaveTypeOption[]
  balances: LeaveBalance[]
  leave: MyLeaveRequest[]
  shiftChanges: MyShiftChange[]
  shifts: { id: string; name: string; startTime: string; endTime: string }[]
  currentShiftId: string | null
  rules: { maxPastDays: number; maxShiftChangeDays: number; workerCanCancelApproved: boolean }
}
