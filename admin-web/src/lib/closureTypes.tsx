import React from 'react'
import { BriefcaseBusiness, CalendarX2, DoorClosed, PartyPopper, Wrench } from 'lucide-react'
import type { ClosureType } from '../types'

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A weekly off day with no calendar entry: closed by the weekly off setting (default Thursday). */
export const WEEKLY_OFF_STYLE = {
  label: 'Weekly Off',
  short: 'Weekly Off',
  icon: <CalendarX2 className="w-3.5 h-3.5" />,
  cell: 'bg-subtle hover:bg-line/60',
  chip: 'bg-subtle text-ink-muted ring-1 ring-inset ring-line-strong',
  dot: 'bg-[var(--color-chart-open)]'
}

/** Whether a Plant Calendar entry closes the plant (adjustment working days do not). */
export const isClosedType = (type: ClosureType) => type !== 'WORKING'

/**
 * Look of each calendar entry type, used in the grid, the side panel and the form. Colours are design
 * tokens: Holiday green, Shutdown red, adjustment Working Day blue, closures neutral slate.
 */
export const CLOSURE_TYPES: Record<
  ClosureType,
  { label: string; short: string; hint: string; icon: React.ReactNode; cell: string; chip: string; dot: string }
> = {
  CLOSED: {
    label: 'Plant Closed',
    short: 'Plant Closed',
    hint: 'Weekly off or unplanned closure',
    icon: <DoorClosed className="w-3.5 h-3.5" />,
    cell: 'bg-subtle hover:bg-line/60',
    chip: 'bg-ink-secondary text-white ring-1 ring-inset ring-ink-secondary',
    dot: 'bg-ink-secondary'
  },
  HOLIDAY: {
    label: 'Holiday',
    short: 'Holiday',
    hint: 'Festival or public holiday',
    icon: <PartyPopper className="w-3.5 h-3.5" />,
    cell: 'bg-success-bg hover:bg-success-line/40',
    chip: 'bg-success-bg text-success ring-1 ring-inset ring-success-line',
    dot: 'bg-[var(--color-chart-completed)]'
  },
  SHUTDOWN: {
    label: 'Shutdown',
    short: 'Shutdown',
    hint: 'Maintenance or production shutdown',
    icon: <Wrench className="w-3.5 h-3.5" />,
    cell: 'bg-missed-bg hover:bg-missed-line/40',
    chip: 'bg-missed-bg text-missed ring-1 ring-inset ring-missed-line',
    dot: 'bg-[var(--color-chart-missed)]'
  },
  WORKING: {
    label: 'Adjustment Working Day',
    short: 'Adjustment Working Day',
    hint: 'Plant runs normally: checks and alerts as scheduled',
    icon: <BriefcaseBusiness className="w-3.5 h-3.5" />,
    cell: 'bg-due-bg hover:bg-due-line/40',
    chip: 'bg-due-bg text-due ring-1 ring-inset ring-due-line',
    dot: 'bg-due'
  }
}
