import type React from 'react'
import { HomeScreen } from './HomeScreen'
import { MoreScreen } from './MoreScreen'
import { AccountScreen } from './AccountScreen'
import { CheckDetailScreen, ChecksScreen, TestCheckScreen } from './ChecksScreens'
import { ExceptionDetailScreen, ExceptionsScreen } from './ExceptionsScreens'
import { ReportsScreen } from './ReportsScreen'
import { USERS_SCREENS } from './UsersScreens'
import { ASSIGNMENTS_SCREENS } from './AssignmentsScreens'
import { MANAGER_ACCESS_SCREENS } from './ManagerAccessScreens'
import { CALENDAR_SCREENS } from './CalendarScreens'
import { CALENDAR_YEARS_SCREENS } from './CalendarYearsScreens'
import { MACHINE_DAY_SCREENS } from './MachineDayScreens'
import { MACHINES_SCREENS } from './MachinesScreens'
import { ACTIVITIES_SCREENS } from './ActivitiesScreens'
import { PARAMETERS_SCREENS } from './ParametersScreens'
import { SCHEDULES_SCREENS } from './SchedulesScreens'
import { MONITORING_SCREENS } from './MonitoringSetupScreens'
import { JOBS_SCREENS } from './JobsScreens'
import { DEPARTMENTS_SCREENS } from './DepartmentsScreens'
import { SHIFTS_SCREENS } from './ShiftsScreens'
import { AUDIT_LOGS_SCREENS } from './AuditLogsScreens'
import { SETTINGS_SCREENS } from './SettingsScreens'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyScreen = React.FC<{ params: any }>

const GROUPS: Record<string, AnyScreen>[] = [
  {
    home: HomeScreen,
    more: MoreScreen,
    account: AccountScreen,
    checks: ChecksScreen,
    checkDetail: CheckDetailScreen,
    testCheck: TestCheckScreen,
    exceptions: ExceptionsScreen,
    exceptionDetail: ExceptionDetailScreen,
    reports: ReportsScreen
  },
  USERS_SCREENS,
  ASSIGNMENTS_SCREENS,
  MANAGER_ACCESS_SCREENS,
  CALENDAR_SCREENS,
  CALENDAR_YEARS_SCREENS,
  MACHINE_DAY_SCREENS,
  MACHINES_SCREENS,
  ACTIVITIES_SCREENS,
  PARAMETERS_SCREENS,
  SCHEDULES_SCREENS,
  MONITORING_SCREENS,
  JOBS_SCREENS,
  DEPARTMENTS_SCREENS,
  SHIFTS_SCREENS,
  AUDIT_LOGS_SCREENS,
  SETTINGS_SCREENS
]

/** Every staff screen by route name. Each one calls the same API as its web panel page. */
export const SCREENS: Record<string, AnyScreen> = {}
for (const group of GROUPS) {
  for (const [name, screen] of Object.entries(group)) {
    if (SCREENS[name]) throw new Error(`Duplicate staff screen name: ${name}`)
    SCREENS[name] = screen
  }
}
