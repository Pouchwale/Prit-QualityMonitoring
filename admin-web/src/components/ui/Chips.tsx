import React from 'react'
import type { Role } from '../../types'
import { ROLE_LABEL } from '../../lib/auth'

/**
 * Small labels and markers shared by the people and organisation pages
 * (design-system/MASTER.md "Status hierarchy"): pills, the initials avatar, role badges and code chips.
 */

const ROLE_BADGE: Record<Role, string> = {
  WORKER: 'bg-subtle text-ink-secondary ring-line',
  MANAGER: 'bg-due-bg text-due ring-due-line',
  ADMIN: 'bg-accent-soft text-accent-strong ring-accent-line',
  SUPER_ADMIN: 'bg-ink text-white ring-ink'
}

/** A small rounded label (role, quality role, "You"). Colours come from the caller's classes. */
export const Pill: React.FC<{ className?: string; title?: string; children: React.ReactNode }> = ({ className = '', title, children }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full ring-1 ring-inset text-[11px] font-medium leading-none whitespace-nowrap ${className}`}
  >
    {children}
  </span>
)

/** Up to two initials of a name, for the avatar circle. */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** Initials in a circle, the same style as the account menu in the top bar. Decorative: the name is always next to it. */
export const UserAvatar: React.FC<{ name: string; muted?: boolean; size?: 'sm' | 'lg' }> = ({ name, muted = false, size = 'sm' }) => (
  <span
    className={`shrink-0 rounded-full ring-1 flex items-center justify-center font-semibold ${
      size === 'lg' ? 'w-14 h-14 text-[17px]' : 'w-8 h-8 text-[11.5px]'
    } ${muted ? 'bg-subtle text-ink-muted ring-line' : 'bg-accent-soft text-accent-strong ring-accent-line'}`}
    aria-hidden
  >
    {initialsOf(name) || '?'}
  </span>
)

export const RoleBadge: React.FC<{ role: Role }> = ({ role }) => <Pill className={ROLE_BADGE[role]}>{ROLE_LABEL[role]}</Pill>

/** Status filter shared by the Departments, Department Configuration and Shifts tables. */
export type StatusTab = 'ALL' | 'ACTIVE' | 'INACTIVE'

export const matchesStatus = (tab: StatusTab, isActive: boolean) => tab === 'ALL' || (tab === 'ACTIVE') === isActive

/** A short code (department code, Item Code prefix, shift code) in a monospace chip. */
export const CodeChip: React.FC<{ children: React.ReactNode; tone?: 'neutral' | 'accent'; className?: string }> = ({ children, tone = 'neutral', className = '' }) => (
  <span
    className={`inline-flex items-center h-5 px-1.5 rounded font-mono text-[11.5px] font-medium leading-none whitespace-nowrap ring-1 ring-inset ${
      tone === 'accent' ? 'bg-accent-soft text-accent-strong ring-accent-line' : 'bg-subtle text-ink-secondary ring-line'
    } ${className}`}
  >
    {children}
  </span>
)
