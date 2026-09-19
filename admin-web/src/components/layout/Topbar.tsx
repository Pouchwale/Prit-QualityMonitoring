import React, { useState, useEffect } from 'react'
import { Bell, Clock, Building2, LogOut, Menu } from 'lucide-react'
import type { CurrentUser } from '../../types'
import { ROLE_LABEL } from '../../lib/auth'
import { formatDate, formatTime } from '../../lib/format'

interface TopbarProps {
  user: CurrentUser
  plantName: string
  /** Current page name, shown in place of the system name on small screens. */
  pageTitle: string
  missedCount: number
  exceptionCount: number
  onOpenAlerts: () => void
  onOpenMenu: () => void
  onLogout: () => void
}

export const Topbar: React.FC<TopbarProps> = ({ user, plantName, pageTitle, missedCount, exceptionCount, onOpenAlerts, onOpenMenu, onLogout }) => {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const alerts = missedCount + exceptionCount

  return (
    <header className="h-14 bg-white border-b border-line pl-1.5 pr-2 sm:px-5 flex items-center justify-between gap-2 shrink-0 no-print select-none">
      {/* Phone and tablet: menu button and the current page */}
      <div className="flex lg:hidden items-center gap-1 min-w-0">
        <button
          onClick={onOpenMenu}
          className="w-[40px] h-[40px] shrink-0 rounded flex items-center justify-center text-ink-secondary hover:bg-slate-50 hover:text-ink"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink leading-tight truncate">{pageTitle}</div>
          {plantName && <div className="text-[11px] text-ink-muted leading-tight truncate">{plantName}</div>}
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden lg:flex items-center gap-1.5 text-xs text-ink-secondary">
        <Building2 className="w-4 h-4 text-ink-muted" />
        {plantName && (
          <>
            <span className="font-semibold text-ink">{plantName}</span>
            <span className="text-line-strong">/</span>
          </>
        )}
        <span className={plantName ? 'text-ink-muted' : 'font-semibold text-ink'}>Quality Assurance System</span>
      </div>

      <div className="flex items-center gap-1 sm:gap-3 shrink-0">
        <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-white border border-line rounded text-xs font-mono text-ink-secondary">
          <Clock className="w-3.5 h-3.5 text-ink-muted" />
          <span>{formatDate(now)}</span>
          <span className="text-line-strong">|</span>
          <span className="font-semibold text-ink">{formatTime(now, true)}</span>
        </div>

        <button
          onClick={onOpenAlerts}
          className="relative w-[40px] h-[40px] lg:w-8 lg:h-8 rounded lg:border border-line flex items-center justify-center text-ink-secondary hover:bg-slate-50 hover:text-ink transition-colors"
          title={`${missedCount} missed today, ${exceptionCount} exceptions today`}
          aria-label={`Alerts: ${missedCount} missed, ${exceptionCount} exceptions today`}
        >
          <Bell className="w-4 h-4" />
          {alerts > 0 && (
            <span className="absolute top-0.5 right-0.5 lg:-top-1 lg:-right-1 min-w-4 h-4 px-1 bg-red-600 text-white rounded-full text-[10px] font-bold flex items-center justify-center">
              {alerts}
            </span>
          )}
        </button>

        <div className="flex items-center gap-1 sm:gap-2 sm:pl-3 sm:border-l border-line">
          <div className="hidden sm:flex w-8 h-8 rounded bg-slate-800 text-white items-center justify-center text-xs font-semibold" title={user.name}>
            {initials}
          </div>
          <div className="hidden md:block text-left">
            <div className="text-xs font-semibold text-ink leading-tight">{user.name}</div>
            <div className="text-[11px] text-ink-muted leading-tight">{ROLE_LABEL[user.role]}</div>
          </div>
          <button
            onClick={onLogout}
            className="sm:ml-1 w-[40px] h-[40px] lg:w-8 lg:h-8 rounded flex items-center justify-center text-ink-muted hover:bg-slate-50 hover:text-ink transition-colors"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  )
}
