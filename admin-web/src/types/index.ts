// Shapes returned by the backend API (backend/src/routes).

export type Role = 'WORKER' | 'MANAGER' | 'ADMIN' | 'SUPER_ADMIN'

/**
 * Admin-panel modules in the permission matrix (backend/src/lib/permissions.ts), set by the Super
 * Admin for the Admin and Manager roles and, where needed, for one user.
 */
export type ModuleKey =
  | 'dashboard'
  | 'checks'
  | 'jobs'
  | 'exceptions'
  | 'reports'
  | 'machines'
  | 'parameters'
  | 'activities'
  | 'schedules'
  | 'shifts'
  | 'departments'
  | 'workers'
  | 'audit_logs'
  | 'settings'
  | 'calendar'
  | 'performance'
  | 'shift_signin'
  | 'wifi_rule'
  // Worker app features (Worker role)
  | 'app_jobs'
  | 'app_performance'
  | 'app_history'

/** The older one-word summary per module: manage = any of create, edit, delete. */
export type Access = 'none' | 'view' | 'manage'
export type Permissions = Record<ModuleKey | 'export', Access>

/** What can be allowed in a module (backend lib/permissions.ts). */
export type Action = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export'
export type ActionSet = Record<Action, boolean>
export type ActionMatrix = Record<ModuleKey, ActionSet>

export interface ModuleInfo {
  key: ModuleKey
  label: string
  description: string
  /** The actions that mean something for this module (e.g. the dashboard can only be viewed). */
  actions: Action[]
  /** What an action allows in this module, when it is not obvious. */
  notes?: Partial<Record<Action, string>>
  /** panel: admin-panel module (Admin, Manager); worker: worker app feature (Worker). */
  audience?: 'panel' | 'worker'
  /** Its records have an active switch: activating / deactivating them is the Super Admin's alone. */
  activation?: boolean
  viewOnly?: boolean
}

/** Roles & Permissions (Super Admin): both roles' permissions and the accounts they apply to. */
export interface PermissionMatrixData {
  roles: Record<'ADMIN' | 'MANAGER' | 'WORKER', ActionMatrix>
  users: (ManagerAccount & { role: 'ADMIN' | 'MANAGER'; overrides: number })[]
}

/** One Admin's or Manager's permissions: their role's, their own rows (replacing the role's), the result. */
export interface UserPermissionData {
  user: { id: string; name: string; employeeId: string; role: 'ADMIN' | 'MANAGER'; isActive: boolean }
  role: ActionMatrix
  overrides: Partial<ActionMatrix>
  effective: ActionMatrix
}

/** A Manager account, as listed on Manager Access. */
export interface ManagerAccount {
  id: string
  employeeId: string
  name: string
  designation: string | null
  isActive: boolean
  lastLoginAt: string | null
}

/**
 * The Manager role's permissions (GET /api/access/roles/manager): one set for every Manager, set
 * by the Super Admin only, with the Manager accounts it applies to.
 */
export interface ManagerRoleAccess {
  permissions: Permissions
  managers: ManagerAccount[]
}
export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL' | 'PHOTO'
export type MachineStatus = 'ACTIVE' | 'MAINTENANCE' | 'IDLE'
/**
 * Internal check state from the API. Only COMPLETED, MISSED and EXCEPTION are ever shown as a
 * status; PENDING / DUE / IN_PROGRESS mean "not finished yet" and are displayed as "—".
 */
export type QualityCheckStatus = 'PENDING' | 'DUE' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED' | 'EXCEPTION'
export type ExceptionStatus = 'UNDER_REVIEW' | 'ACKNOWLEDGED' | 'ACTION_TAKEN' | 'RESOLVED'
export type ValueResult = 'PASS' | 'FAIL' | 'NA'

/** When a parameter is asked for: always, or only while a job is running on the machine. */
export type AppliesWhen = 'ALWAYS' | 'JOB_RUNNING'
/** How a schedule produces checks: on its interval, or only while a job runs. */
export type ScheduleMode = 'INTERVAL' | 'JOB'
/** A check type's monitoring mode on a machine. MANUAL = linked with no schedule. */
export type MonitoringMode = ScheduleMode | 'MANUAL'
/** Who started the check: the scheduler (notification) or the worker (manual). */
export type SubmissionType = 'NOTIFICATION' | 'MANUAL'

/** Overall result of a check (backend/src/lib/result.ts). Null while the check is still open. */
export type CheckResult = 'COMPLETED' | 'MISSED' | 'EXCEPTION'

export interface CurrentUser {
  id: string
  name: string
  employeeId: string
  role: Role
  designation: string | null
  departmentName: string | null
  shiftName: string | null
  shiftStartTime: string | null
  shiftEndTime: string | null
  /** View / create / edit / delete per module: the role's permissions with the user's own on top (Super Admin: everything). */
  actions?: ActionMatrix
  /** The same as one word per module (older servers send only this). */
  permissions: Permissions
}

export interface Department {
  id: string
  name: string
  code: string
  isActive: boolean
  /**
   * The active Item Code prefixes of this department (upper case), from Department Configuration.
   * A job whose Item Code starts with one of them belongs to this department: the server works it out.
   */
  itemCodePrefixes?: string[]
}

/** Department Configuration: one Item Code prefix and the department it stands for. */
export interface DepartmentMapping {
  id: string
  prefix: string
  departmentId: string
  departmentName: string
  departmentCode: string
  departmentActive: boolean
  isActive: boolean
  /** Jobs (any status) whose Item Code starts with this prefix; a used mapping cannot be deleted. */
  jobCount: number
  createdAt: string
  createdByName: string | null
  updatedAt: string
  updatedByName: string | null
}

export interface Shift {
  id: string
  name: string
  code: string
  startTime: string
  endTime: string
  graceMinutes: number
  isActive: boolean
}

export interface Machine {
  id: string
  name: string
  code: string
  /** The main department (the first of `departments`), kept for older screens. */
  departmentId: string | null
  departmentName: string | null
  /** Every department the machine works for; empty when none is set. */
  departmentIds: string[]
  departments: { id: string; code: string; name: string; isActive: boolean }[]
  line: string | null
  model: string | null
  status: MachineStatus
  notes: string | null
  isActive: boolean
  activityIds: string[]
}

export interface Parameter {
  id: string
  name: string
  code: string
  type: ParameterType
  unit: string | null
  minValue: number | null
  maxValue: number | null
  options: string[]
  /** Dropdown only: a first choice (e.g. the material) the worker makes before the options. */
  materialOptions: string[]
  /** Dropdown only: the worker may choose several options instead of one. */
  multiSelect: boolean
  /** The departments this parameter is used by. Empty: unassigned, so every check type may use it. */
  departmentIds: string[]
  departmentNames: string[]
  /** Default "required" value when the parameter is added to a quality check type. */
  isRequired: boolean
  isActive: boolean
  sortOrder: number
  description: string | null
  departmentId: string | null
  departmentName: string | null
  /** Human-readable acceptance rule generated by the server. */
  rule: string | null
  activityIds: string[]
}

/** When a parameter of a job-based check type is checked. */
export type ParameterFrequency = 'JOB_START' | 'INTERVAL' | 'JOB_END'

export interface ActivityParameter {
  parameterId: string
  sortOrder: number
  isRequired: boolean
  isEnabled: boolean
  /** The worker must attach a live photo for this parameter. */
  requirePhoto: boolean
  /** The worker must record a video for this parameter. */
  requireVideo: boolean
  /** The worker may mark this parameter Not Applicable with a reason. */
  allowNa: boolean
  appliesWhen: AppliesWhen
  /** Job-based check types: when this parameter is checked. */
  frequency: ParameterFrequency
  intervalMinutes: number
  name: string
  code: string
  type: ParameterType
  unit: string | null
  parameterActive: boolean
}

export type QualityModule = 'IPQC' | 'QC'
export type WorkerQualityRole = 'IPQC' | 'QC' | 'BOTH'

/** A quality check type (process): its parameters, evidence rules and machines. */
export interface Activity {
  id: string
  name: string
  code: string
  module: QualityModule
  departmentId: string | null
  departmentName: string | null
  description: string | null
  /** Overall check photo, on top of the per-parameter evidence. */
  requirePhoto: boolean
  /** Overall check video, on top of the per-parameter evidence. */
  requireVideo: boolean
  requireJobNo: boolean
  /** Workers may start this check themselves, without waiting for a notification. */
  allowManual: boolean
  /** SHIFT: shift schedules. JOB: checked per job (start, intervals, end). */
  monitoring: 'SHIFT' | 'JOB'
  /** Job interval checks count as Missed this long after they are due. */
  graceMinutes: number
  isActive: boolean
  machineIds: string[]
  parameters: ActivityParameter[]
}

export interface ModuleDeviceAssignment {
  module: QualityModule
  userId: string | null
  userName: string | null
  userPhone: string | null
  employeeId: string | null
  updatedAt?: string
}

export interface ModuleDevicesResponse {
  ipqc: ModuleDeviceAssignment
  qc: ModuleDeviceAssignment
  workers: { id: string; name: string; employeeId: string; phone: string | null }[]
}

export interface Schedule {
  id: string
  machineId?: string | null
  activityId: string
  shiftId?: string | null
  workerId: string | null
  departmentId?: string | null
  departmentName?: string | null
  module?: QualityModule
  activityModule?: QualityModule | null
  intervalMinutes: number
  /** INTERVAL: a check every `intervalMinutes`. JOB: only while a job runs on the machine. */
  mode: ScheduleMode
  startTime: string | null
  endTime: string | null
  isActive: boolean
  machineName?: string | null
  activityName: string
  shiftName?: string | null
  shiftStartTime?: string | null
  shiftEndTime?: string | null
  workerName: string | null
  workerEmployeeId: string | null
  workerQualityRole?: WorkerQualityRole | null
  /** Workers who get this schedule's checks. Empty: no worker on this machine and shift, so no checks. */
  /** Stored monitoring timer (schedule_timers), when the server sends it. */
  nextDueAt?: string | null
  lastSubmittedAt?: string | null
}

/** A schedule that creates no checks because its machine has no worker on that shift. */
export interface WorkerGap {
  scheduleId: string
  machineName: string
  shiftName: string
  activityName: string
}

export interface User {
  id: string
  employeeId: string
  name: string
  role: Role
  workerQualityRole?: WorkerQualityRole
  designation: string | null
  departmentId: string | null
  departmentName: string | null
  shiftId: string | null
  shiftName: string | null
  phone: string | null
  isActive: boolean
  /** May sign in to the worker mobile app. */
  appAccess: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface MediaFile {
  id: string
  kind: 'PHOTO' | 'VIDEO'
  /** The parameter this evidence belongs to; null for overall (or legacy) check evidence. */
  parameterId: string | null
  /** Relative URL, use mediaUrl() from lib/api. */
  url: string
  mimeType: string
  sizeBytes: number
  sha256: string
  /** Compression before storage; null for files stored before it existed. */
  processing?: 'PENDING' | 'COMPRESSED' | 'ORIGINAL' | 'FAILED' | null
  /** Size as the phone sent it. */
  originalSizeBytes?: number | null
  width?: number | null
  height?: number | null
  durationSeconds: number | null
  capturedAt: string | null
  createdAt: string
}

export interface CheckValue {
  parameterId: string | null
  parameterName: string
  parameterType: ParameterType
  unit: string | null
  rule: string | null
  value: string | null
  result: ValueResult
  /** Marked Not Applicable by the worker (or because no job was running). Never counts as a failure. */
  notApplicable: boolean
  naReason: string | null
  naRemark: string | null
  appliesWhen: AppliesWhen | null
}

export interface CheckException {
  id: string
  reason: string
  remark: string | null
  /** The reading the reason asked for, e.g. "Viscosity: 21.5 sec" (null: none). */
  reading?: string | null
  status: ExceptionStatus
  reviewedByName: string | null
  resolutionNotes: string | null
  createdAt: string
  media: MediaFile[]
}

export interface QualityCheck {
  id: string
  code: string
  scheduleId: string | null
  machineId?: string | null
  machineName?: string | null
  machineCode?: string | null
  departmentId: string | null
  departmentName: string | null
  activityId: string
  activityName: string
  module?: QualityModule
  workerId: string | null
  workerName: string | null
  workerEmployeeId: string | null
  shiftId: string | null
  shiftName: string | null
  scheduledAt: string
  windowEndsAt: string
  status: QualityCheckStatus
  result: CheckResult | null
  itemCode?: string | null
  jobNo: string | null
  /** MANUAL when the worker started the check, NOTIFICATION when the scheduler did. */
  submissionType: SubmissionType | null
  jobId: string | null
  /** When the next check of this schedule became due, worked out at submission. */
  nextDueAt: string | null
  submittedAt: string | null
  submittedById: string | null
  submittedByName: string | null
  submittedByEmployeeId: string | null
  deviceInfo: string | null
  values: CheckValue[]
  media: MediaFile[]
  exception: CheckException | null
  /** SCHEDULED (shift schedule) or a job check (older servers leave it out). */
  kind?: CheckKind
  /** Job checks: the parameters this check asks for. */
  parameterIds?: string[] | null
  /** The job this check belongs to, on the single-check endpoint. */
  job?: Job | null
}

/** A configurable "Not Applicable" reason offered to workers (GET /api/monitoring-reasons). */
/** Whether a piece of evidence is asked for with an exception: not at all, optional, or required. */
export type EvidenceRule = 'OFF' | 'OPTIONAL' | 'REQUIRED'

export interface MonitoringReason {
  id: string
  label: string
  /** The worker must type a remark when choosing this reason. */
  requiresRemark: boolean
  /** Exception reasons only: the exception must name the PO No. / Item Code as well as the machine. */
  requiresJobDetails?: boolean
  /** Exception reasons only: photo and video evidence, each OFF / OPTIONAL / REQUIRED. */
  photoEvidence?: EvidenceRule
  videoEvidence?: EvidenceRule
  /** Exception reasons only: a reading the worker must enter (e.g. "Viscosity"), and its unit; null: none. */
  readingLabel?: string | null
  readingUnit?: string | null
  isActive: boolean
  sortOrder: number
}

/** A production job on a machine. Job-based checks only run while one is open (GET /api/jobs). */
export interface Job {
  id: string
  machineId: string
  machineName?: string | null
  machineCode?: string | null
  itemCode?: string | null
  jobNo: string
  /** Null while the job is only planned. */
  startedAt: string | null
  startedById: string | null
  startedByName: string | null
  endedAt: string | null
  endedById?: string | null
  endedByName?: string | null
  /** Checks submitted against this job. */
  checkCount?: number
  /** Minutes from start to end, or to now while the job runs. */
  durationMinutes?: number | null
  status?: JobStatus
}

/** PLANNED → STARTING (Job Start check) → ACTIVE → ENDING (Job End check) → COMPLETED. */
export type JobStatus = 'PLANNED' | 'STARTING' | 'ACTIVE' | 'ENDING' | 'COMPLETED' | 'CANCELLED'

/** SCHEDULED: shift schedule check. JOB_*: a job's start, interval or end check. */
export type CheckKind = 'SCHEDULED' | 'JOB_START' | 'JOB_INTERVAL' | 'JOB_END'

/** A job in the admin Jobs list (GET /api/jobs). */
export interface JobRow extends Job {
  machineName: string
  machineCode: string
  status: JobStatus
  activatedAt: string | null
  endRequestedAt: string | null
  assignedWorkerId: string | null
  assignedWorkerName: string | null
  plannedFor: string | null
  note: string | null
  forceClosed: boolean
  /**
   * The department doing this job. Nobody picks it: the server works it out from the Item Code
   * prefix (set on Departments) when the job is planned, and again when a worker starts it.
   */
  departmentId: string | null
  departmentName: string | null
  /** NONE: no Job Start / Job End parameters. PENDING: open. DONE: submitted. */
  startCheck: 'NONE' | 'PENDING' | 'DONE'
  endCheck: 'NONE' | 'PENDING' | 'DONE'
  handovers: number
  counts: { total: number; pending: number; due: number; overdue: number; completed: number; missed: number; exception: number }
}

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

export interface ExceptionRecord extends CheckException {
  checkId: string
  checkCode: string
  machineId: string
  machineName: string
  departmentName: string | null
  activityName: string
  workerName: string | null
  workerEmployeeId: string | null
  scheduledAt: string
}

export interface AuditLog {
  id: string
  userId: string | null
  userName: string | null
  role: string | null
  action: string
  entity: string
  entityId: string | null
  oldValue: unknown
  newValue: unknown
  ipAddress: string | null
  createdAt: string
}

export interface KPISummary {
  scheduled: number
  /** Checks whose result is Completed. */
  completed: number
  missed: number
  exceptions: number
  /** Checks not finished yet (no status). */
  open: number
  completionRate: number
}

export interface MachineSummary {
  machineId: string
  machineName: string
  total: number
  completed: number
  missed: number
  exceptions: number
  open: number
}

export interface DashboardData {
  from: string
  to: string
  /** Which departments this dashboard covers: always all of them now, for Managers too. */
  scope?: PerformanceScope
  kpi: KPISummary
  byMachine: MachineSummary[]
  recent: QualityCheck[]
  /** Set when the plant is closed on the chosen day (Plant Calendar). */
  closure: { id: string | null; date: string; type: ClosureType; label: string; reason: string | null; weeklyOff?: boolean } | null
}

/** Plant Calendar entry type. WORKING is an adjustment working day: the plant runs normally. */
export type ClosureType = 'CLOSED' | 'HOLIDAY' | 'SHUTDOWN' | 'WORKING'

/** Whether the plant is open on a date, and why (GET /api/plant-closures/days). */
export interface DayState {
  date: string
  closed: boolean
  source: 'ENTRY' | 'WEEKLY' | 'OPEN'
  /** The weekly closure falls on this date (an entry may override it). */
  weeklyClosed: boolean
  entry: { id: string; type: ClosureType; reason: string | null; calendarYearId: string | null } | null
  label: string | null
  /** The date has a machine day plan: only these machines run (null: the plant calendar decides). */
  machinePlan?: { count: number; machineIds: string[] } | null
}

/** Machines that run on one date. Without a plan every machine follows the plant calendar. */
export interface MachineDayPlan {
  date: string
  note: string | null
  machineIds: string[]
  machines: { id: string; name: string; code: string }[]
  updatedAt: string
  updatedByName: string | null
}

/** A recurring weekly closure from 2027 onwards (inclusive dates; no end date = open-ended). */
export interface WeeklyRule {
  id: string
  weekday: number
  effectiveFrom: string
  effectiveTo: string | null
  note: string | null
  updatedAt: string
}

export type CalendarYearStatus = 'DRAFT' | 'APPROVED'

export interface CalendarYear {
  id: string
  year: number
  status: CalendarYearStatus
  pendingChanges: boolean
  sourceFileName: string | null
  sourceMimeType: string | null
  extractionMethod: 'EXCEL' | 'PDF_TEXT' | 'OCR' | 'MANUAL' | null
  extractionNote: string | null
  hasDocument: boolean
  approvedAt: string | null
  updatedAt: string
}

export interface CalendarYearSummary extends CalendarYear {
  holidays: number
  workingDays: number
  openIssues: number
}

export interface CalendarYearItem {
  id: string
  type: ClosureType
  date: string | null
  name: string | null
  forHolidayDate: string | null
  printedWeekday: string | null
  sourceText: string | null
  sourceRow: number | null
  uncertainFields: string[]
  confirmed: boolean
  position: number
}

export interface CalendarIssue {
  code: string
  severity: 'BLOCKING' | 'CHECK' | 'INFO'
  message: string
  itemId: string | null
}

export interface CalendarYearDetail {
  year: CalendarYear
  items: CalendarYearItem[]
  issues: CalendarIssue[]
  canApprove: boolean
  publishedCount: number
}

/** A date the plant is closed. No checks, alerts or Missed checks on that date. */
export interface PlantClosure {
  id: string
  /** Local date, YYYY-MM-DD. */
  date: string
  type: ClosureType
  reason: string | null
  updatedAt: string
}

export type Settings = Record<string, unknown>

/** Traceability for an Item Code / PO No. / worker report (GET /api/reports/trace). */
export interface TraceCounts {
  checks: number
  completed: number
  missed: number
  exceptions: number
  open: number
  readings: number
  outsideLimits: number
  notApplicable: number
  changes: number
  corrections: number
}

export interface TraceGroup extends TraceCounts {
  key: string
  itemCodes: string[]
  jobNos: string[]
  workers: string[]
  machines: string[]
  firstAt: string | null
  lastAt: string | null
}

export interface TraceWorker extends TraceGroup {
  workerId: string | null
  name: string
  employeeId: string | null
  items: { itemCode: string; jobNos: string[]; checks: number; completed: number; missed: number; exceptions: number; changes: number }[]
}

export interface TraceChange {
  at: string
  checkId: string
  checkCode: string
  machineName: string
  machineCode: string
  itemCode: string
  jobNo: string
  parameterName: string
  unit: string | null
  from: string
  to: string
  fromResult: string
  toResult: string
  correction: boolean
  wentOutside: boolean
  byName: string
  byEmployeeId: string | null
  byId: string | null
  previousAt: string
  previousByName: string
}

export interface TraceReport {
  counts: TraceCounts
  items: TraceGroup[]
  jobs: TraceGroup[]
  workers: TraceWorker[]
  changes: TraceChange[]
}

/** Worker performance (backend services/performance.ts): the score comes from the backend. */
export interface WorkerPerformance {
  workerId: string
  workerName: string
  employeeId: string
  /** Checks whose time window has ended, or that are finished. */
  assigned: number
  completed: number
  /** Exceptions count as done for the score. */
  exceptions: number
  /** Checks marked Missed. */
  missed: number
  /** Still open: shown, but not counted in assigned or the score. */
  open: number
  /** completionRate − 100, where exceptions count as done; 0 means everything was done. */
  score: number
  completionRate: number
}

/**
 * Which departments the figures cover. Managers are no longer limited to one department, so the
 * server always sends restricted: false; the other fields are kept for older servers.
 */
export interface PerformanceScope {
  /** Older servers: the department a Manager was limited to; null otherwise. */
  departmentId: string | null
  departmentName: string | null
  restricted: boolean
  /** Older servers: a Manager whose account had no department saw nobody. */
  missingDepartment: boolean
}

export interface PerformanceFilterValues {
  machines: { id: string; name: string }[]
  shifts: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  workers: { id: string; name: string; employeeId: string; departmentId: string | null }[]
  scope: PerformanceScope
}

export interface PerformanceResult {
  from: string
  to: string
  scope: PerformanceScope
  totals: { workers: number; assigned: number; completed: number; exceptions: number; missed: number; open: number; score: number; completionRate: number }
  workers: WorkerPerformance[]
}

export interface ReportSharingSettings {
  id?: string
  isEnabled: boolean
  frequencyHours: number
  frequencyMinutes: number
  frequencyMode: 'INTERVAL' | 'DAILY_AT' | 'DAILY_REPORT'
  scheduledTime: string | null
  percentage: number
  recipients: string[]
  lastRunAt: string | null
  nextRunAt: string | null
  smtpHost: string | null
  smtpPort: number | null
  smtpSecure: boolean
  smtpUser: string | null
  smtpPass: string | null
  smtpFrom: string | null
  /** Send time (HH:MM) of the daily previous-day task report (frequencyMode DAILY_REPORT). */
  dailyReportTime?: string
  /** Where failure alerts of automated report emails go; set by the Super Admin only. */
  failureAlertEmail?: string | null
  updatedAt?: string
}

/**
 * A report email's delivery (backend services/reportDelivery.ts). SENT means the mail server
 * accepted it, not that it was received or read.
 */
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'RETRYING'

export interface RecipientDelivery {
  email: string
  status: DeliveryStatus
  error?: string | null
  at?: string | null
}

export interface ReportEmailLog {
  id: string
  trigger: 'AUTO' | 'MANUAL' | 'DAILY'
  status: DeliveryStatus
  recipients: string[]
  subject: string
  checkIds: string[]
  checksCount: number
  periodFrom: string | null
  periodTo: string | null
  percentage: number | null
  pdfSizeBytes: number | null
  videoCount: number
  errorMessage: string | null
  sentAt: string
  sentById: string | null
  sentByName: string | null
  /** Each recipient's delivery; empty on emails from before delivery tracking. */
  recipientStatus?: RecipientDelivery[]
  attempts?: number
  lastAttemptAt?: string | null
  nextRetryAt?: string | null
  failureKind?: 'TEMPORARY' | 'PERMANENT' | null
  recoveredAt?: string | null
}

/** A failed automated report email, for the Super Admin's popup. */
export interface ReportEmailAlert {
  id: string
  logId: string
  failedAt: string
  errorMessage: string | null
  failedRecipients: string[]
  alertEmailStatus: 'SENT' | 'FAILED' | 'NOT_CONFIGURED' | 'SKIPPED' | null
  alertEmailTo: string | null
  alertEmailError: string | null
  alertEmailAt: string | null
  readAt: string | null
  dismissedAt: string | null
  scheduleName: string
  canRetry: boolean
  email: {
    id: string
    trigger: string
    subject: string
    recipients: string[]
    status: DeliveryStatus
    attempts: number
    nextRetryAt: string | null
    failureKind: string | null
    recoveredAt: string | null
    errorMessage: string | null
    recipientStatus: RecipientDelivery[]
    sentAt: string
    retryStatus: string
  }
}

export interface SamplePreviewResult {
  periodFrom: string
  periodTo: string
  percentage: number
  eligibleTotal: number
  sampleCount: number
  sampledCheckIds: string[]
  checks: {
    id: string
    code: string
    submittedAt: string | null
    scheduledAt: string
    itemCode: string | null
    jobNo: string | null
    machineName: string
    machineCode: string
    workerName: string
    status: string
    result: string | null
    photoCount: number
    videoCount: number
    hasException: boolean
    outsideLimitsCount: number
  }[]
}

