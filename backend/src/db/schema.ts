import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  index,
  uniqueIndex,
  date
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['WORKER', 'ADMIN', 'MANAGER', 'SUPER_ADMIN'])
export const parameterTypeEnum = pgEnum('parameter_type', ['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL', 'PHOTO'])
export const machineStatusEnum = pgEnum('machine_status', ['ACTIVE', 'MAINTENANCE', 'IDLE'])
export const checkStatusEnum = pgEnum('check_status', [
  'PENDING',
  'DUE',
  'IN_PROGRESS',
  'COMPLETED',
  'MISSED',
  'EXCEPTION'
])
export const valueResultEnum = pgEnum('value_result', ['PASS', 'FAIL', 'NA'])
/** When a parameter has to be filled in: always, or only while a job is running on the machine. */
export const appliesWhenEnum = pgEnum('applies_when', ['ALWAYS', 'JOB_RUNNING'])
/** INTERVAL: due every interval inside the shift. JOB: due only while a job is running. */
export const scheduleModeEnum = pgEnum('schedule_mode', ['INTERVAL', 'JOB'])
/** How a check was submitted: after a due notification, or started by the worker. */
export const submissionTypeEnum = pgEnum('submission_type', ['NOTIFICATION', 'MANUAL'])
/** A job's lifecycle: planned → Job Start check → active → Job End check → completed. */
export const jobStatusEnum = pgEnum('job_status', ['PLANNED', 'STARTING', 'ACTIVE', 'ENDING', 'COMPLETED', 'CANCELLED'])
/** SCHEDULED: shift schedule check (every parameter). JOB_*: a job check with only the parameters due. */
export const checkKindEnum = pgEnum('check_kind', ['SCHEDULED', 'JOB_START', 'JOB_INTERVAL', 'JOB_END'])
/** When a parameter of a job-based check type is checked. */
export const parameterFrequencyEnum = pgEnum('parameter_frequency', ['JOB_START', 'INTERVAL', 'JOB_END'])
/** SHIFT: checks come from shift schedules. JOB: checks follow each job (start, intervals, end). */
export const activityMonitoringEnum = pgEnum('activity_monitoring', ['SHIFT', 'JOB'])
export const mediaKindEnum = pgEnum('media_kind', ['PHOTO', 'VIDEO'])
/**
 * How a stored photo/video was optimised (services/mediaOptimizer.ts): PENDING (video waiting to be
 * compressed), COMPRESSED (the stored file is the compressed one), ORIGINAL (kept as uploaded because
 * it was already small), FAILED (could not be compressed; the upload is kept). Null for older files.
 */
export const mediaProcessingEnum = pgEnum('media_processing', ['PENDING', 'COMPRESSED', 'ORIGINAL', 'FAILED'])
export const exceptionStatusEnum = pgEnum('exception_status', [
  'UNDER_REVIEW',
  'ACKNOWLEDGED',
  'ACTION_TAKEN',
  'RESOLVED'
])

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
}

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  code: text('code').notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
})

export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  /** Local time, HH:MM */
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  /** Minutes a check stays DUE after its scheduled time before it becomes MISSED. */
  graceMinutes: integer('grace_minutes').notNull().default(15),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: text('employee_id').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  /**
   * The password encrypted with the server's password-view key (lib/passwordVault.ts), so the
   * Super Admin can view it. Null for passwords set before this existed, until they are next set.
   */
  passwordEncrypted: text('password_encrypted'),
  role: roleEnum('role').notNull().default('WORKER'),
  /** Job title shown on the worker profile, e.g. "Quality Inspector". */
  designation: text('designation'),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
  phone: text('phone'),
  isActive: boolean('is_active').notNull().default(true),
  /** Whether the user may sign in to the worker mobile app. */
  appAccess: boolean('app_access').notNull().default(true),
  /**
   * What the worker's latest device reported when it tried to turn on alerts, including why it
   * could not (e.g. Expo Go without a project id, permission denied, web app without HTTPS).
   * Lets "Test alert" explain a missing registration instead of just saying none exists.
   */
  alertStatus: jsonb('alert_status').$type<{ status: string; platform: string | null; detail: string | null; at: string }>(),
  /** Incremented to invalidate all refresh tokens for this user. */
  tokenVersion: integer('token_version').notNull().default(0),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps
})

export const machines = pgTable('machines', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
  line: text('line'),
  model: text('model'),
  status: machineStatusEnum('status').notNull().default('ACTIVE'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
})

/** Machines a worker is allowed to check (worker access). */
export const workerMachines = pgTable(
  'worker_machines',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.userId, t.machineId] })]
)

export const parameters = pgTable('parameters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  type: parameterTypeEnum('type').notNull(),
  unit: text('unit'),
  minValue: doublePrecision('min_value'),
  maxValue: doublePrecision('max_value'),
  options: jsonb('options').$type<string[]>().notNull().default([]),
  /** Default for new activity assignments; each activity can override it. */
  isRequired: boolean('is_required').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  description: text('description'),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  ...timestamps
})

/** A quality check template (process) with its parameters and evidence rules. */
export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  description: text('description'),
  /** "Overall check photo/video": one photo/video for the whole check, next to the per-parameter rules. */
  requirePhoto: boolean('require_photo').notNull().default(true),
  requireVideo: boolean('require_video').notNull().default(false),
  requireJobNo: boolean('require_job_no').notNull().default(true),
  /** The worker may start this check from the machine screen without waiting for a notification. */
  allowManual: boolean('allow_manual').notNull().default(true),
  /** SHIFT: shift schedules create the checks. JOB: each job's start, interval and end checks. */
  monitoring: activityMonitoringEnum('monitoring').notNull().default('SHIFT'),
  /** Job interval checks stay open this long after they are due, then count as Missed. */
  graceMinutes: integer('grace_minutes').notNull().default(20),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
})

export const activityParameters = pgTable(
  'activity_parameters',
  {
    activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    parameterId: uuid('parameter_id').notNull().references(() => parameters.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    isRequired: boolean('is_required').notNull().default(true),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Evidence the worker must capture for this parameter, on top of its reading. */
    requirePhoto: boolean('require_photo').notNull().default(false),
    requireVideo: boolean('require_video').notNull().default(false),
    /** The worker may mark this parameter "Not Applicable" with one of the monitoring reasons. */
    allowNa: boolean('allow_na').notNull().default(false),
    /** JOB_RUNNING parameters are automatically Not Applicable when no job runs on the machine. */
    appliesWhen: appliesWhenEnum('applies_when').notNull().default('ALWAYS'),
    /** Job-based check types: checked at job start, every `intervalMinutes`, or at job end. */
    frequency: parameterFrequencyEnum('frequency').notNull().default('INTERVAL'),
    intervalMinutes: integer('interval_minutes').notNull().default(60)
  },
  (t) => [primaryKey({ columns: [t.activityId, t.parameterId] })]
)

/** Which activities apply to which machines (machine-wise quality checks). */
export const machineActivities = pgTable(
  'machine_activities',
  {
    machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'cascade' }),
    activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.machineId, t.activityId] })]
)

export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'restrict' }),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  shiftId: uuid('shift_id').notNull().references(() => shifts.id, { onDelete: 'restrict' }),
  /** Optional: when empty, each check goes to the worker assigned to the machine on that shift (services/workerAssignment.ts). */
  workerId: uuid('worker_id').references(() => users.id, { onDelete: 'set null' }),
  intervalMinutes: integer('interval_minutes').notNull(),
  /** Optional window inside the shift (HH:MM). Defaults to the shift times. */
  startTime: text('start_time'),
  endTime: text('end_time'),
  /** INTERVAL: checks all through the shift. JOB: only while a job runs on the machine. */
  mode: scheduleModeEnum('mode').notNull().default('INTERVAL'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
})

/**
 * A production job on a machine, started and ended by the worker. JOB schedules only create
 * checks while a job is running, and every submission records the job it belongs to.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'restrict' }),
    /** The item (product) being produced in this job, entered with the Job No. */
    itemCode: text('item_code'),
    jobNo: text('job_no').notNull(),
    /** Null while the job is only planned (planned jobs insert it as null explicitly). */
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedById: uuid('ended_by_id').references(() => users.id, { onDelete: 'set null' }),
    status: jobStatusEnum('status').notNull().default('ACTIVE'),
    /** The worker responsible now: job checks and their notifications go to this worker. */
    assignedWorkerId: uuid('assigned_worker_id').references(() => users.id, { onDelete: 'set null' }),
    plannedById: uuid('planned_by_id').references(() => users.id, { onDelete: 'set null' }),
    plannedFor: date('planned_for'),
    note: text('note'),
    /** When the Job Start check was completed; interval checks count from here. */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    endRequestedAt: timestamp('end_requested_at', { withTimezone: true }),
    endRequestedById: uuid('end_requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Closed by an Admin/Manager without the Job End check. */
    forceClosed: boolean('force_closed').notNull().default(false),
    ...timestamps
  },
  (t) => [
    // At most one running job per machine; planned jobs do not count.
    uniqueIndex('jobs_running_per_machine_idx').on(t.machineId).where(sql`${t.status} in ('STARTING', 'ACTIVE', 'ENDING')`),
    index('jobs_machine_started_idx').on(t.machineId, t.startedAt),
    index('jobs_status_idx').on(t.status)
  ]
)

/** Every handover of a running job from one worker to another. */
export const jobHandovers = pgTable(
  'job_handovers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'set null' }),
    toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'set null' }),
    toShiftId: uuid('to_shift_id').references(() => shifts.id, { onDelete: 'set null' }),
    note: text('note'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Open checks that moved to the new worker. */
    movedChecks: integer('moved_checks').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('job_handovers_job_idx').on(t.jobId, t.createdAt)]
)

/**
 * The reasons a worker can choose when marking a parameter "Not Applicable" (Monitoring Setup).
 * Editable by admins; deleting is soft (isActive = false) so old submissions keep their reason.
 */
export const monitoringReasons = pgTable('monitoring_reasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  /** "Other" needs the worker to write what happened. */
  requiresRemark: boolean('requires_remark').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps
})

/**
 * The rolling timer of a schedule (machine + check type + shift): when the last check was
 * submitted and when the next one is due. Every submission restarts it (services/monitoringTimer.ts).
 */
export const scheduleTimers = pgTable('schedule_timers', {
  scheduleId: uuid('schedule_id')
    .primaryKey()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  lastSubmittedAt: timestamp('last_submitted_at', { withTimezone: true }),
  lastCheckId: uuid('last_check_id').references(() => qualityChecks.id, { onDelete: 'set null' }),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const qualityChecks = pgTable(
  'quality_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'restrict' }),
    activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
    workerId: uuid('worker_id').references(() => users.id, { onDelete: 'set null' }),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
    status: checkStatusEnum('status').notNull().default('PENDING'),
    overallResult: text('overall_result').$type<'PASS' | 'FAIL' | null>(),
    itemCode: text('item_code'),
    jobNo: text('job_no'),
    /**
     * MANUAL for a check the worker started from the machine screen, NOTIFICATION for a check
     * the scheduler created. Set when the check is started and kept on submission.
     */
    submissionType: submissionTypeEnum('submission_type'),
    /** The job running on the machine when the check was started or submitted. */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** When the next check of this schedule became due, worked out at submission (for audit). */
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedById: uuid('submitted_by_id').references(() => users.id, { onDelete: 'set null' }),
    deviceInfo: text('device_info'),
    /** When the "check is due" notification was sent, so it is sent only once. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    /** SCHEDULED (shift schedule) or a job check: JOB_START, JOB_INTERVAL, JOB_END. */
    kind: checkKindEnum('kind').notNull().default('SCHEDULED'),
    /** Job checks: exactly the parameters this check asks for. Null: every parameter of the check type. */
    parameterIds: uuid('parameter_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    unique('quality_checks_schedule_slot').on(t.scheduleId, t.scheduledAt),
    index('quality_checks_scheduled_at_idx').on(t.scheduledAt),
    /**
     * One open check per schedule: the rolling "next check" (services/checkGenerator.ts).
     * Concurrent ticks and processes insert with onConflictDoNothing against this index.
     */
    uniqueIndex('quality_checks_one_open_per_schedule')
      .on(t.scheduleId)
      .where(sql`${t.status} in ('PENDING', 'DUE')`),
    /**
     * One open job check per job, check type, kind and due time: each parameter runs on its own
     * frequency, so several interval checks can be open at once (services/jobMonitoring.ts).
     */
    uniqueIndex('quality_checks_one_open_job_check')
      .on(t.jobId, t.activityId, t.kind, t.scheduledAt)
      .where(sql`${t.kind} <> 'SCHEDULED' and ${t.status} in ('PENDING', 'DUE', 'IN_PROGRESS')`),
    index('quality_checks_job_idx').on(t.jobId)
  ]
)

export const qualityCheckValues = pgTable('quality_check_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkId: uuid('check_id').notNull().references(() => qualityChecks.id, { onDelete: 'cascade' }),
  parameterId: uuid('parameter_id').references(() => parameters.id, { onDelete: 'set null' }),
  // Snapshot of the configuration at submission time, so history survives config changes.
  parameterName: text('parameter_name').notNull(),
  parameterType: parameterTypeEnum('parameter_type').notNull(),
  unit: text('unit'),
  rule: text('rule'),
  value: text('value'),
  result: valueResultEnum('result').notNull().default('NA'),
  /** The worker marked this parameter Not Applicable; it is never counted as a failed reading. */
  notApplicable: boolean('not_applicable').notNull().default(false),
  /** Reason label snapshot (monitoring_reasons) and the worker's remark. */
  naReason: text('na_reason'),
  naRemark: text('na_remark'),
  /** Applicability rule snapshot at submission time. */
  appliesWhen: appliesWhenEnum('applies_when'),
  sortOrder: integer('sort_order').notNull().default(0)
})

export const checkExceptions = pgTable('exceptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkId: uuid('check_id').notNull().unique().references(() => qualityChecks.id, { onDelete: 'cascade' }),
  workerId: uuid('worker_id').references(() => users.id, { onDelete: 'set null' }),
  machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  remark: text('remark'),
  status: exceptionStatusEnum('status').notNull().default('UNDER_REVIEW'),
  reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
  resolutionNotes: text('resolution_notes'),
  ...timestamps
})

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: mediaKindEnum('kind').notNull(),
  checkId: uuid('check_id').references(() => qualityChecks.id, { onDelete: 'cascade' }),
  exceptionId: uuid('exception_id').references(() => checkExceptions.id, { onDelete: 'cascade' }),
  /** The parameter this evidence belongs to. Null means overall (or legacy) check evidence. */
  parameterId: uuid('parameter_id').references(() => parameters.id, { onDelete: 'set null' }),
  /** Storage-relative path, e.g. quality-checks/2026-09-15/<uuid>.jpg */
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** SHA-256 of the stored file. */
  sha256: text('sha256').notNull(),
  durationSeconds: doublePrecision('duration_seconds'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  uploadedById: uuid('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processing: mediaProcessingEnum('processing'),
  /** Size and SHA-256 of the file as the phone sent it (a reused capture is refused by this hash). */
  originalSizeBytes: integer('original_size_bytes'),
  originalSha256: text('original_sha256'),
  /** Pixel size of the stored file, upright. */
  width: integer('width'),
  height: integer('height')
}, (t) => [
  index('media_sha256_idx').on(t.sha256),
  index('media_original_sha256_idx').on(t.originalSha256),
  index('media_processing_pending_idx').on(t.createdAt).where(sql`${t.processing} = 'PENDING'`)
])

/**
 * Devices that receive "check is due" notifications, one row per device a worker signs in on.
 * kind 'expo': the Android/iOS app, `token` is the Expo push token.
 * kind 'web': the browser/PWA, `token` is the Web Push endpoint URL and `subscription`
 * holds the full PushSubscription (endpoint + keys) needed to encrypt the message.
 */
export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  kind: text('kind').$type<'expo' | 'web'>().notNull().default('expo'),
  subscription: jsonb('subscription').$type<{ endpoint: string; keys: { p256dh: string; auth: string } }>(),
  platform: text('platform'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

/**
 * What a Manager may use. One row per manager and module; a missing row means no access.
 * Admins and Super Admins are not listed here: they always have full access.
 */
export const managerPermissions = pgTable(
  'manager_permissions',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    canView: boolean('can_view').notNull().default(false),
    canManage: boolean('can_manage').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [primaryKey({ columns: [t.userId, t.module] })]
)

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  userName: text('user_name'),
  role: text('role'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [index('audit_logs_created_at_idx').on(t.createdAt)])

/**
 * Plant Calendar entry type. CLOSED, HOLIDAY and SHUTDOWN close the plant; WORKING marks an
 * adjustment working day, shown in the calendar while the plant runs normally.
 */
export const closureTypeEnum = pgEnum('closure_type', ['CLOSED', 'HOLIDAY', 'SHUTDOWN', 'WORKING'])

/**
 * Days the plant is closed (Plant Calendar). One row per local date. On these dates no checks are
 * scheduled, no due alerts are sent and nothing is marked Missed (services/plantCalendar.ts).
 */
export const calendarYearStatusEnum = pgEnum('calendar_year_status', ['DRAFT', 'APPROVED'])

/**
 * A company holiday calendar for one year (2027 onwards). Its dates are reviewed as
 * calendar_year_items and only affect scheduling once approved, when they are published to
 * plant_closures. Dates before 2027 keep the original Plant Calendar data and are not modelled here.
 */
export const calendarYears = pgTable('calendar_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull().unique(),
  status: calendarYearStatusEnum('status').notNull().default('DRAFT'),
  /** Approved year whose items were edited since: the published dates stay live until approved again. */
  pendingChanges: boolean('pending_changes').notNull().default(false),
  sourceFileName: text('source_file_name'),
  /** Relative to the calendar documents folder; served only to signed-in admins. */
  sourcePath: text('source_path'),
  sourceMimeType: text('source_mime_type'),
  /** EXCEL, PDF_TEXT, OCR or MANUAL. */
  extractionMethod: text('extraction_method'),
  extractionNote: text('extraction_note'),
  approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
})

/** A date in a calendar year under review: as extracted from the company document, then edited by the admin. */
export const calendarYearItems = pgTable(
  'calendar_year_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarYearId: uuid('calendar_year_id')
      .notNull()
      .references(() => calendarYears.id, { onDelete: 'cascade' }),
    type: closureTypeEnum('type').notNull(),
    /** Null when the date could not be read; the item then blocks approval. */
    date: date('date', { mode: 'string' }),
    /** Holiday name, or a note for an adjustment day. */
    name: text('name'),
    /** Adjustment Working Day: the holiday date it makes up for. */
    forHolidayDate: date('for_holiday_date', { mode: 'string' }),
    /** Weekday as printed on the document, for cross-checking the date. */
    printedWeekday: text('printed_weekday'),
    /** The original text read from the document, e.g. "૨૯/૦૧/૨૦૨૬". */
    sourceText: text('source_text'),
    sourceRow: integer('source_row'),
    /** Values the extraction could not read with confidence. They never count as approved until confirmed. */
    uncertainFields: jsonb('uncertain_fields').$type<string[]>().notNull().default([]),
    /** The admin has checked this item against the document. */
    confirmed: boolean('confirmed').notNull().default(false),
    position: integer('position').notNull().default(0),
    ...timestamps
  },
  (t) => [index('calendar_year_items_year_idx').on(t.calendarYearId)]
)

/**
 * Recurring weekly closures from 2027 onwards, e.g. every Thursday. A rule applies between its
 * effective dates (inclusive), so changing or ending a rule never rewrites earlier dates.
 */
export const plantWeeklyRules = pgTable('plant_weekly_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 0 = Sunday … 6 = Saturday. */
  weekday: integer('weekday').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  effectiveTo: date('effective_to', { mode: 'string' }),
  note: text('note'),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
})

export const plantClosures = pgTable('plant_closures', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Local date, YYYY-MM-DD. */
  date: date('date', { mode: 'string' }).notNull().unique(),
  type: closureTypeEnum('type').notNull().default('CLOSED'),
  reason: text('reason'),
  /** Set for dates published from an approved calendar year (2027 onwards). */
  calendarYearId: uuid('calendar_year_id').references(() => calendarYears.id, { onDelete: 'set null' }),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/**
 * Machine day plans: for a date, exactly which machines run. A date with a plan overrides the
 * plant calendar for machines (listed ones run even on a closed day, unlisted ones do not run);
 * a date without a plan follows the plant calendar (services/machineDays.ts).
 */
export const machineDayPlans = pgTable('machine_day_plans', {
  /** Local date, YYYY-MM-DD. */
  date: date('date', { mode: 'string' }).primaryKey(),
  note: text('note'),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const machineDayPlanMachines = pgTable(
  'machine_day_plan_machines',
  {
    date: date('date', { mode: 'string' })
      .notNull()
      .references(() => machineDayPlans.date, { onDelete: 'cascade' }),
    machineId: uuid('machine_id').notNull().references(() => machines.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.date, t.machineId] })]
)
