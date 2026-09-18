import React from 'react'
import { BriefcaseBusiness, CalendarX2, DoorClosed, PartyPopper, Wrench } from 'lucide-react'
import type { ClosureType } from '../types'

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A weekly off day with no calendar entry: closed by the weekly off setting (default Thursday). */
export const WEEKLY_OFF_STYLE = {
  label: 'Weekly Off',
  short: 'Weekly Off',
  icon: <CalendarX2 className="w-3.5 h-3.5" />,
  cell: 'bg-slate-100/70 hover:bg-slate-100',
  chip: 'bg-slate-400 text-white',
  dot: 'bg-slate-400'
}

/** Whether a Plant Calendar entry closes the plant (adjustment working days do not). */
export const isClosedType = (type: ClosureType) => type !== 'WORKING'

/** Look of each calendar entry type, used in the grid, the side panel and the form. */
export const CLOSURE_TYPES: Record<
  ClosureType,
  { label: string; short: string; hint: string; icon: React.ReactNode; cell: string; chip: string; dot: string }
> = {
  CLOSED: {
    label: 'Plant Closed',
    short: 'Plant Closed',
    hint: 'Weekly off or unplanned closure',
    icon: <DoorClosed className="w-3.5 h-3.5" />,
    cell: 'bg-slate-100/80 hover:bg-slate-100',
    chip: 'bg-slate-700 text-white',
    dot: 'bg-slate-600'
  },
  HOLIDAY: {
    label: 'Holiday',
    short: 'Holiday',
    hint: 'Festival or public holiday',
    icon: <PartyPopper className="w-3.5 h-3.5" />,
    cell: 'bg-emerald-50 hover:bg-emerald-100/70',
    chip: 'bg-emerald-600 text-white',
    dot: 'bg-emerald-500'
  },
  SHUTDOWN: {
    label: 'Shutdown',
    short: 'Shutdown',
    hint: 'Maintenance or production shutdown',
    icon: <Wrench className="w-3.5 h-3.5" />,
    cell: 'bg-rose-50 hover:bg-rose-100/70',
    chip: 'bg-rose-600 text-white',
    dot: 'bg-rose-500'
  },
  WORKING: {
    label: 'Adjustment Working Day',
    short: 'Adjustment Working Day',
    hint: 'Plant runs normally: checks and alerts as scheduled',
    icon: <BriefcaseBusiness className="w-3.5 h-3.5" />,
    cell: 'bg-sky-50 hover:bg-sky-100/70',
    chip: 'bg-sky-600 text-white',
    dot: 'bg-sky-500'
  }
}
