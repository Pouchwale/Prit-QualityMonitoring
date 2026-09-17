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
  date
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['WORKER', 'ADMIN', 'MANAGER', 'SUPER_ADMIN'])
export const parameterTypeEnum = pgEnum('parameter_type', ['NUMBER', 'TEXT', 'DROPDOWN', 'YES_NO', 'PASS_FAIL'])
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
export const mediaKindEnum = pgEnum('media_kind', ['PHOTO', 'VIDEO'])
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
  requirePhoto: boolean('require_photo').notNull().default(true),
  requireVideo: boolean('require_video').notNull().default(false),
  requireJobNo: boolean('require_job_no').notNull().default(true),
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
    isEnabled: boolean('is_enabled').notNull().default(true)
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
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps
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
    jobNo: text('job_no'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedById: uuid('submitted_by_id').references(() => users.id, { onDelete: 'set null' }),
    deviceInfo: text('device_info'),
    /** When the "check is due" notification was sent, so it is sent only once. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    unique('quality_checks_schedule_slot').on(t.scheduleId, t.scheduledAt),
    index('quality_checks_scheduled_at_idx').on(t.scheduledAt)
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
  /** Storage-relative path, e.g. quality-checks/2026-09-15/<uuid>.jpg */
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  durationSeconds: doublePrecision('duration_seconds'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  uploadedById: uuid('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [index('media_sha256_idx').on(t.sha256)])

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

/** How a closed day is labelled in the Plant Calendar. */
export const closureTypeEnum = pgEnum('closure_type', ['CLOSED', 'HOLIDAY', 'SHUTDOWN'])

/**
 * Days the plant is closed (Plant Calendar). One row per local date. On these dates no checks are
 * scheduled, no due alerts are sent and nothing is marked Missed (services/plantCalendar.ts).
 */
export const plantClosures = pgTable('plant_closures', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Local date, YYYY-MM-DD. */
  date: date('date', { mode: 'string' }).notNull().unique(),
  type: closureTypeEnum('type').notNull().default('CLOSED'),
  reason: text('reason'),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})
