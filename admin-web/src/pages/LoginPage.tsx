import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Clock3, Eye, EyeOff, Info, Lock, LockKeyhole, Server, ShieldCheck, UserRound } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { API_URL, ApiError, errorText } from '../lib/api'
import { sessionEnded } from '../lib/routes'
import { Button } from '../components/common/Button'
import { TextInput } from '../components/common/Form'
import { ThemeSwitch } from '../components/common/ThemeSwitch'

/**
 * The sign-in screen (design-system/MASTER.md). Presentation only: signing in is `useAuth().login`
 * exactly as before, and every message shown comes from the server or the session state.
 *
 * Layout (desktop): the brand side on the canvas tone, its statement framed by printer's crop marks,
 * beside the form on the card surface. Phones and tablets: the brand
 * shrinks to a header above the form. The dark-mode switch sits top right in both.
 */

type Notice = { tone: 'error' | 'locked' | 'info'; title: string; message?: string }

export const LoginPage: React.FC = () => {
  const { login } = useAuth()
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  // Fields left empty when the form was sent: shown next to the field, nothing is sent to the server.
  const [missing, setMissing] = useState<{ employeeId?: boolean; password?: boolean }>({})
  // Why this page is shown: the server ended the previous session (read once, then cleared).
  const [notice, setNotice] = useState<Notice | null>(() => {
    if (!sessionEnded.active) return null
    sessionEnded.active = false
    return { tone: 'info', title: 'Your session has expired', message: 'Please sign in again to continue.' }
  })
  const idRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  // After a refused sign-in the password field gets focus again, once it is enabled (not loading).
  const refocusPassword = useRef(false)
  useEffect(() => {
    if (!loading && refocusPassword.current) {
      refocusPassword.current = false
      passwordRef.current?.focus()
    }
  }, [loading])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // The same rule as before (both fields are needed), with the reason shown on the field.
    const empty = { employeeId: !employeeId.trim(), password: !password }
    if (empty.employeeId || empty.password) {
      setMissing(empty)
      ;(empty.employeeId ? idRef : passwordRef).current?.focus()
      return
    }
    setLoading(true)
    setNotice(null)
    try {
      await login(employeeId.trim(), password)
    } catch (err) {
      // The server's own words (wrong ID or password, account disabled, too many attempts); a
      // lockout (429) gets its own look so it is not mistaken for a typing mistake.
      const locked = err instanceof ApiError && err.status === 429
      // A refused sign-in shows the server's sentence as it is; anything else (server unreachable)
      // gets the friendly explanation with what to do.
      const message = err instanceof ApiError && err.status < 500 ? err.message : errorText(err)
      setNotice({ tone: locked ? 'locked' : 'error', title: locked ? 'Sign-in temporarily locked' : 'Could not sign you in', message })
      if (!locked) {
        setPassword('')
        refocusPassword.current = true
      }
    } finally {
      setLoading(false)
    }
  }

  const onPasswordKey = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)

  return (
    <div className="min-h-dvh grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] bg-surface">
      <BrandPanel />

      <main className="relative flex flex-col min-h-dvh">
        <header className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-8 lg:px-10 lg:pt-6">
          <div className="flex items-center gap-3 lg:invisible">
            <img src="/logo.png" alt="" className="w-9 h-9 rounded-[10px] ring-1 ring-line" />
            <div>
              <div className="text-[16px] font-semibold text-ink leading-tight">Quality Monitoring</div>
              <div className="text-[13.5px] text-ink-muted leading-tight">Admin Panel</div>
            </div>
          </div>
          <ThemeSwitch />
        </header>

        <div className="flex-1 flex items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-[380px] animate-enter">
            <div className="mb-8">
              <h1 className="text-[29px] font-semibold text-ink tracking-[-0.02em] leading-[1.15]">Welcome back</h1>
              <p className="mt-2 text-[16px] text-ink-muted">Sign in to monitor checks, jobs and reports.</p>
            </div>

            {notice && <NoticeBox notice={notice} />}

            <form onSubmit={submit} noValidate className="space-y-5" aria-describedby={notice ? 'login-notice' : undefined}>
              <LoginField id="login-employee-id" label="Employee ID" error={missing.employeeId ? 'Enter your employee ID.' : null}>
                <UserRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none" aria-hidden />
                <TextInput
                  id="login-employee-id"
                  ref={idRef}
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={employeeId}
                  onChange={(e) => {
                    setEmployeeId(e.target.value)
                    if (missing.employeeId) setMissing((m) => ({ ...m, employeeId: false }))
                  }}
                  placeholder="Enter your employee ID"
                  disabled={loading}
                  aria-invalid={missing.employeeId || undefined}
                  aria-describedby={missing.employeeId ? 'login-employee-id-error' : undefined}
                  className={loginInput}
                />
              </LoginField>

              <LoginField
                id="login-password"
                label="Password"
                error={missing.password ? 'Enter your password.' : null}
                hint={capsLock ? 'Caps Lock is on.' : null}
              >
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none" aria-hidden />
                <TextInput
                  id="login-password"
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (missing.password) setMissing((m) => ({ ...m, password: false }))
                  }}
                  onKeyUp={onPasswordKey}
                  onKeyDown={onPasswordKey}
                  placeholder="Enter your password"
                  disabled={loading}
                  aria-invalid={missing.password || undefined}
                  aria-describedby={[missing.password ? 'login-password-error' : null, capsLock ? 'login-password-hint' : null].filter(Boolean).join(' ') || undefined}
                  className={`${loginInput} pr-11`}
                />
                {/* Shared plant PCs: let the user check what they typed before signing in. */}
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-1 right-1 w-9 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-subtle transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </LoginField>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full !h-11 !text-[15.5px] mt-1 active:scale-[0.99]"
                loading={loading}
                iconRight={<ArrowRight className="w-4 h-4" aria-hidden />}
                aria-live="polite"
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </div>
        </div>

        <footer className="px-5 pb-6 sm:px-8">
          <div className="max-w-[380px] mx-auto pt-5 border-t border-line flex flex-col gap-2 text-[13.5px] text-ink-muted">
            <span className="flex items-start gap-2">
              <ShieldCheck className="w-3.5 h-3.5 mt-[2px] text-ink-faint shrink-0" aria-hidden />
              For administrators and quality managers. Forgot your password? Ask your Super Admin.
            </span>
            <span className="flex items-center gap-2 font-mono text-[12.5px] [overflow-wrap:anywhere]" title="Server this panel signs in to">
              <Server className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
              {API_URL}
            </span>
          </div>
        </footer>
      </main>
    </div>
  )
}

/** Taller fields than the rest of the console: the first screen people see, often on shared PCs. */
const loginInput = '!h-11 !text-[16.5px] lg:!text-[15.5px] pl-9'

/** A label above its field, with the field's error (or hint) under it, linked by id. */
const LoginField: React.FC<{ id: string; label: string; error: string | null; hint?: string | null; children: React.ReactNode }> = ({
  id,
  label,
  error,
  hint,
  children
}) => (
  <div>
    <label htmlFor={id} className="block text-[14.5px] font-medium text-ink-secondary mb-1.5">
      {label}
    </label>
    <div className="relative">{children}</div>
    {error ? (
      <p id={`${id}-error`} className="mt-1.5 flex items-center gap-1.5 text-[14px] text-missed" role="alert">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
        {error}
      </p>
    ) : hint ? (
      <p id={`${id}-hint`} className="mt-1.5 flex items-center gap-1.5 text-[14px] text-exception">
        <Info className="w-3.5 h-3.5 shrink-0" aria-hidden />
        {hint}
      </p>
    ) : null}
  </div>
)

const NOTICE_STYLE = {
  error: { box: 'border-missed-line bg-missed-bg', icon: 'text-missed', Icon: AlertCircle },
  locked: { box: 'border-exception-line bg-exception-bg', icon: 'text-exception', Icon: LockKeyhole },
  info: { box: 'border-accent-line bg-accent-soft', icon: 'text-accent-strong', Icon: Clock3 }
}

/** The message above the form: a failed sign-in, a lockout or an ended session. */
const NoticeBox: React.FC<{ notice: Notice }> = ({ notice }) => {
  const s = NOTICE_STYLE[notice.tone]
  return (
    <div id="login-notice" className={`mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 animate-enter ${s.box}`} role={notice.tone === 'info' ? 'status' : 'alert'}>
      <s.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.icon}`} aria-hidden />
      <div className="min-w-0">
        <div className="text-[14.5px] font-semibold text-ink">{notice.title}</div>
        {notice.message && <div className="text-[14px] text-ink-secondary mt-0.5">{notice.message}</div>}
      </div>
    </div>
  )
}

/**
 * The brand side on wide screens: logo and name at the top, then the product statement framed by
 * printer's crop marks (index.css "Sign-in page print motif").
 * No pattern or gradient, so the form stays the focus.
 */
const BrandPanel: React.FC = () => (
  <aside className="hidden lg:flex flex-col bg-canvas border-r border-line px-12 xl:px-16 py-6">
    <div className="h-10 flex items-center gap-3 animate-enter">
      <img src="/logo.png" alt="" className="w-9 h-9 rounded-[10px] ring-1 ring-line" />
      <div>
        <div className="text-[16px] font-semibold text-ink leading-tight">Quality Monitoring</div>
        <div className="text-[13.5px] text-ink-muted leading-tight">Admin Panel</div>
      </div>
    </div>

    <div className="flex-1 flex items-center py-12">
      <div className="relative w-full max-w-[520px] px-9 py-10">
        <span className="crop-mark crop-mark-tl" aria-hidden />
        <span className="crop-mark crop-mark-tr" aria-hidden />
        <span className="crop-mark crop-mark-bl" aria-hidden />
        <span className="crop-mark crop-mark-br" aria-hidden />

        <h2 className="text-[40px] xl:text-[46px] font-semibold text-ink tracking-[-0.03em] leading-[1.06] max-w-[15ch] animate-enter [animation-delay:60ms]">
          Quality checks for every machine, shift and job.
        </h2>
        <p className="mt-5 text-[17px] leading-relaxed text-ink-secondary max-w-[40ch] animate-enter [animation-delay:120ms]">
          Periodic checks, exceptions and reports for the whole plant, in one place.
        </p>
      </div>
    </div>
  </aside>
)
