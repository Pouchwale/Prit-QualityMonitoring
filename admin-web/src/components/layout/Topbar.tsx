import React, { useEffect, useRef, useState } from 'react'
import { Bell, Building2, ChevronDown, LogOut, Menu, UserRound } from 'lucide-react'
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
  onOpenAccount: () => void
  onLogout: () => void
}

/**
 * The header (design-system/MASTER.md "Navigation"): the plant on the left (the page title on small
 * screens), then the plant clock, alerts with today's count and the account menu.
 */
export const Topbar: React.FC<TopbarProps> = ({ user, plantName, pageTitle, missedCount, exceptionCount, onOpenAlerts, onOpenMenu, onOpenAccount, onLogout }) => {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // The clock shows minutes, so it only needs to change once a minute.
    const timer = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(timer)
  }, [])

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const alerts = missedCount + exceptionCount

  // The header has its own layer above the page (relative z-30): backdrop-blur makes it a stacking context,
  // so without one the account menu (z-50 inside it) would draw under positioned page content such as a
  // date field. It stays below the phone navigation drawer (z-40), dialogs and toasts.
  return (
    <header className="relative z-30 h-14 bg-white/95 backdrop-blur border-b border-line pl-1.5 pr-2 sm:px-5 flex items-center justify-between gap-2 shrink-0 no-print select-none">
      {/* Phone and tablet: menu button and the current page */}
      <div className="flex lg:hidden items-center gap-1 min-w-0">
        <button
          onClick={onOpenMenu}
          className="w-[40px] h-[40px] shrink-0 rounded-md flex items-center justify-center text-ink-secondary hover:bg-subtle hover:text-ink"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink leading-tight truncate">{pageTitle}</div>
          {plantName && <div className="text-[11.5px] text-ink-muted leading-tight truncate">{plantName}</div>}
        </div>
      </div>

      {/* Desktop: where you are */}
      <div className="hidden lg:flex items-center gap-2 text-[12.5px] min-w-0">
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-subtle text-ink-secondary min-w-0">
          <Building2 className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
          <span className="font-medium text-ink truncate">{plantName || 'Quality Assurance System'}</span>
        </span>
        <span className="text-ink-faint" aria-hidden>
          /
        </span>
        <span className="font-medium text-ink-secondary truncate">{pageTitle}</span>
      </div>

      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        <div className="hidden lg:flex flex-col items-end leading-tight pr-1" aria-label={`Plant time ${formatTime(now)}, ${formatDate(now)}`}>
          <span className="text-[13px] font-semibold text-ink tabular-nums">{formatTime(now)}</span>
          <span className="text-[11px] text-ink-muted tabular-nums">{formatDate(now)}</span>
        </div>

        <button
          onClick={onOpenAlerts}
          className="relative w-[40px] h-[40px] lg:w-9 lg:h-9 rounded-md flex items-center justify-center text-ink-secondary hover:bg-subtle hover:text-ink transition-colors"
          title={`${missedCount} missed today, ${exceptionCount} exceptions today`}
          aria-label={`Alerts: ${missedCount} missed, ${exceptionCount} exceptions today`}
        >
          <Bell className="w-[18px] h-[18px]" />
          {alerts > 0 && (
            <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 bg-[var(--color-chart-missed)] text-white rounded-full text-[10.5px] font-semibold tabular-nums flex items-center justify-center ring-2 ring-white">
              {alerts > 99 ? '99+' : alerts}
            </span>
          )}
        </button>

        <span className="hidden sm:block w-px h-6 bg-line" aria-hidden />
        <UserMenu user={user} initials={initials} onOpenAccount={onOpenAccount} onLogout={onLogout} />
      </div>
    </header>
  )
}

/**
 * The account button and its menu (My Account, Sign out). Escape or a click outside closes it and
 * focus returns to the button.
 */
const UserMenu: React.FC<{ user: CurrentUser; initials: string; onOpenAccount: () => void; onLogout: () => void }> = ({ user, initials, onOpenAccount, onLogout }) => {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLElement)
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <div className="relative" ref={root}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}, ${ROLE_LABEL[user.role]}`}
        className="flex items-center gap-2 h-[40px] lg:h-9 pl-1 pr-1.5 sm:pr-2 rounded-md hover:bg-subtle transition-colors"
      >
        <span className="w-8 h-8 lg:w-7 lg:h-7 rounded-full bg-accent-soft text-accent-strong ring-1 ring-accent-line flex items-center justify-center text-[11.5px] font-semibold" aria-hidden>
          {initials}
        </span>
        <span className="hidden md:block text-left leading-tight" aria-hidden>
          <span className="block text-[12.5px] font-semibold text-ink max-w-[160px] truncate">{user.name}</span>
          <span className="block text-[11px] text-ink-muted">{ROLE_LABEL[user.role]}</span>
        </span>
        <ChevronDown className={`hidden sm:block w-3.5 h-3.5 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 top-full mt-1.5 z-50 w-56 card shadow-[var(--shadow-pop)] py-1.5">
          <div className="px-3 pt-1 pb-2 border-b border-line mb-1">
            <div className="text-[12.5px] font-semibold text-ink truncate">{user.name}</div>
            <div className="text-[11.5px] text-ink-muted truncate">
              {user.employeeId} · {ROLE_LABEL[user.role]}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onOpenAccount)}
            className="w-full flex items-center gap-2.5 px-3 h-9 text-[13px] text-ink-secondary hover:bg-subtle hover:text-ink focus-visible:bg-subtle focus-visible:outline-none"
          >
            <UserRound className="w-4 h-4 text-ink-faint" aria-hidden />
            My Account
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onLogout)}
            className="w-full flex items-center gap-2.5 px-3 h-9 text-[13px] text-missed hover:bg-missed-bg focus-visible:bg-missed-bg focus-visible:outline-none"
          >
            <LogOut className="w-4 h-4" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
