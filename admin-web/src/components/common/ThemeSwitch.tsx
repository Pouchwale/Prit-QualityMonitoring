import React from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../../lib/theme'

/**
 * Dark mode on/off. A switch (role="switch") whose thumb carries a sun or a moon; the choice is
 * saved in this browser and kept after a reload (lib/theme.ts).
 */
export const ThemeSwitch: React.FC = () => {
  const { theme, setTheme } = useTheme()
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Dark mode on. Switch to light mode' : 'Dark mode off. Switch to dark mode'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="group w-[44px] h-[40px] lg:h-9 shrink-0 rounded-md flex items-center justify-center"
    >
      <span
        className={`relative w-9 h-5 rounded-full ring-1 ring-inset transition-colors duration-200 ${
          dark ? 'bg-accent-fill ring-accent-fill' : 'bg-subtle ring-line-strong group-hover:ring-ink-faint/60'
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.3)] flex items-center justify-center transition-transform duration-200 ease-out ${
            dark ? 'translate-x-4' : 'translate-x-0'
          }`}
        >
          {dark ? <Moon className="w-2.5 h-2.5 text-accent" strokeWidth={2.5} /> : <Sun className="w-2.5 h-2.5 text-exception" strokeWidth={2.5} />}
        </span>
      </span>
    </button>
  )
}
