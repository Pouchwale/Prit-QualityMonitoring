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
  const baseClasses =
    'inline-flex items-center justify-center whitespace-nowrap shrink-0 font-medium rounded-md transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed select-none'

  // Touch-sized below lg, compact from lg up (design-system/MASTER.md "Buttons").
  const sizeClasses = {
    sm: 'h-[36px] min-w-[36px] lg:h-[30px] lg:min-w-0 px-3 lg:px-2.5 text-[13px] lg:text-[12.5px] gap-1.5',
    md: 'h-[40px] lg:h-[34px] px-3.5 text-[14px] lg:text-[13px] gap-1.5',
    lg: 'h-[44px] lg:h-[38px] px-4 text-sm gap-2',
    field: 'h-[40px] lg:h-8 px-3 lg:px-2.5 text-[13px] lg:text-[12.5px] gap-1.5'
  }

  const variantClasses = {
    primary: 'bg-accent text-white border border-accent hover:bg-accent-strong hover:border-accent-strong active:bg-blue-800 shadow-[0_1px_2px_rgb(37_99_235/0.25)] focus-visible:ring-accent',
    secondary: 'bg-subtle text-ink border border-line hover:bg-line active:bg-line-strong focus-visible:ring-ink-faint',
    outline: 'bg-white text-ink border border-line-strong hover:bg-subtle hover:border-ink-faint/40 shadow-[0_1px_1px_rgb(15_23_42/0.04)] focus-visible:ring-ink-faint',
    ghost: 'bg-transparent text-ink-secondary border border-transparent hover:bg-subtle hover:text-ink focus-visible:ring-ink-faint',
    danger: 'bg-failed text-white border border-failed hover:bg-missed hover:border-missed active:bg-red-800 focus-visible:ring-failed'
  }

  return (
    <button
      className={`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-3.5 w-3.5 text-current" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
