import React from 'react'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
  /** `field` matches the height of a form input, for buttons placed next to one. */
  size?: 'sm' | 'md' | 'lg' | 'field'
  icon?: React.ReactNode
  iconRight?: React.ReactNode
  loading?: boolean
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  className = '',
  disabled,
  ...props
}) => {
  const baseClasses = 'inline-flex items-center justify-center whitespace-nowrap shrink-0 font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed select-none'

  // Touch-sized below lg (pixel heights: the root font is 13.5px), the original compact sizes from lg up.
  const sizeClasses = {
    sm: 'h-[36px] min-w-[36px] lg:h-7 lg:min-w-0 px-3 lg:px-2.5 text-[13px] lg:text-xs gap-1.5',
    md: 'h-[40px] lg:h-[34px] px-3 text-[14px] lg:text-[13px] gap-1.5',
    lg: 'h-[44px] lg:h-[38px] px-4 text-sm gap-2',
    field: 'h-[40px] lg:h-8 px-3 lg:px-2.5 text-[13px] lg:text-xs gap-1.5'
  }

  const variantClasses = {
    primary: 'bg-accent text-white hover:bg-blue-700 focus:ring-accent border border-accent shadow-xs active:bg-blue-900',
    secondary: 'bg-subtle text-ink hover:bg-line focus:ring-ink-faint border border-line-strong active:bg-line-strong',
    outline: 'bg-white text-slate-700 hover:bg-slate-50 hover:text-ink focus:ring-ink-faint border border-line shadow-2xs',
    ghost: 'bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink focus:ring-ink-faint border border-transparent',
    danger: 'bg-failed text-white hover:bg-missed focus:ring-failed border border-failed shadow-xs active:bg-red-800'
  }

  return (
    <button
      className={`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-3.5 w-3.5 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      ) : (
        icon && <span className="shrink-0 flex items-center">{icon}</span>
      )}
      {children && <span>{children}</span>}
      {iconRight && !loading && <span className="shrink-0 flex items-center">{iconRight}</span>}
    </button>
  )
}
