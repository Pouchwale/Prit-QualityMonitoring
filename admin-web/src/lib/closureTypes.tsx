import React from 'react'
import { DoorClosed, PartyPopper, Wrench } from 'lucide-react'
import type { ClosureType } from '../types'

/** Look of each closure type, used in the grid, the side panel and the form. */
export const CLOSURE_TYPES: Record<ClosureType, { label: string; hint: string; icon: React.ReactNode; cell: string; chip: string; dot: string }> = {
  CLOSED: {
    label: 'Plant Closed',
    hint: 'Weekly off or unplanned closure',
    icon: <DoorClosed className="w-3.5 h-3.5" />,
    cell: 'bg-slate-100/80 hover:bg-slate-100',
    chip: 'bg-slate-700 text-white',
    dot: 'bg-slate-600'
  },
  HOLIDAY: {
    label: 'Holiday',
    hint: 'Festival or public holiday',
    icon: <PartyPopper className="w-3.5 h-3.5" />,
    cell: 'bg-emerald-50 hover:bg-emerald-100/70',
    chip: 'bg-emerald-600 text-white',
    dot: 'bg-emerald-500'
  },
  SHUTDOWN: {
    label: 'Shutdown',
    hint: 'Maintenance or production shutdown',
    icon: <Wrench className="w-3.5 h-3.5" />,
    cell: 'bg-rose-50 hover:bg-rose-100/70',
    chip: 'bg-rose-600 text-white',
    dot: 'bg-rose-500'
  }
}
