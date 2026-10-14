import React from 'react'
import { WifiOff } from 'lucide-react'
import type { LiveState } from '../../lib/useLiveRefresh'

const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Whether the page is keeping itself up to date (lib/useLiveRefresh.ts), and since when. */
export const LiveBadge: React.FC<{ state: LiveState }> = ({ state }) =>
  state.status === 'offline' ? (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-missed-bg text-missed ring-1 ring-inset ring-missed-line text-[11.5px] font-medium whitespace-nowrap"
      title="The server could not be reached. The page keeps trying and updates itself when it is back."
    >
      <WifiOff className="w-3.5 h-3.5" aria-hidden />
      Offline · retrying{state.syncedAt ? ` · last ${time(state.syncedAt)}` : ''}
    </span>
  ) : (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-subtle text-ink-secondary ring-1 ring-inset ring-line text-[11.5px] font-medium whitespace-nowrap"
      title="Changes made anywhere, such as a worker's new shift, appear here within a few seconds."
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-chart-completed)]" aria-hidden />
      Live{state.syncedAt ? ` · ${time(state.syncedAt)}` : ''}
    </span>
  )
