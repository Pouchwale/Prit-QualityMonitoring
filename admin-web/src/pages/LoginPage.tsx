import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Clock3, Eye, EyeOff, Info, Lock, LockKeyhole, Server, ShieldCheck, UserRound } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { API_URL, ApiError, errorText } from '../lib/api'
import { sessionEnded } from '../lib/routes'
import { Button } from '../components/common/Button'
import { TextInput } from '../components/common/Form'

/**
 * The sign-in screen (design-system/MASTER.md). Presentation only: signing in is `useAuth().login`
 * exactly as before, and every message shown comes from the server or the session state.
 *
 * Layout: a light brand panel (logo, name, one line) beside the form on wide screens; on smaller
 * screens it shrinks to a header above the form.
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
    <div className="min-h-dvh grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] bg-surface">
      <BrandPanel />

      <main className="flex flex-col min-h-dvh lg:min-h-0">
        {/* Small screens: the brand as a header above the form */}
        <header className="lg:hidden flex items-center gap-3 px-5 pt-6 sm:px-8">
          <img src="/logo.png" alt="" className="w-10 h-10 rounded-xl ring-1 ring-line bg-white" />
          <div>
            <div className="text-[15px] font-semibold text-ink leading-tight">Quality Monitoring</div>
            <div className="text-[12px] text-ink-muted">Admin Panel</div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-[380px] animate-enter">
            <div className="mb-7">
              <h1 className="text-[26px] font-semibold text-ink tracking-tight leading-tight">Welcome back</h1>
              <p className="mt-1.5 text-[14px] text-ink-muted">Sign in to monitor checks, jobs and reports.</p>
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

              <Button type="submit" variant="primary" size="lg" className="w-full !h-11 !text-[14px]" loading={loading} aria-live="polite">
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <div className="mt-8 pt-5 border-t border-line flex flex-col gap-2 text-[12px] text-ink-muted">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
                For administrators and quality managers. Forgot your password? Ask your Super Admin.
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] [overflow-wrap:anywhere]">
                <Server className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
                {API_URL}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

/** Taller fields than the rest of the console: the first screen people see, often on shared PCs. */
const loginInput = '!h-11 !text-[15px] lg:!text-[14px] pl-9'

/** A label above its field, with the field's error (or hint) under it, linked by id. */
const LoginField: React.FC<{ id: string; label: string; error: string | null; hint?: string | null; children: React.ReactNode }> = ({
  id,
  label,
  error,
  hint,
  children
}) => (
  <div>
    <label htmlFor={id} className="block text-[13px] font-medium text-ink-secondary mb-1.5">
      {label}
    </label>
    <div className="relative">{children}</div>
    {error ? (
      <p id={`${id}-error`} className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-missed" role="alert">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
        {error}
      </p>
    ) : hint ? (
      <p id={`${id}-hint`} className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-exception">
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
        <div className="text-[13px] font-semibold text-ink">{notice.title}</div>
        {notice.message && <div className="text-[12.5px] text-ink-secondary mt-0.5">{notice.message}</div>}
      </div>
    </div>
  )
}

/**
 * The left panel on wide screens: the logo, the product name and one short line, on a light
 * surface. Nothing else, so the form stays the focus.
 */
const BrandPanel: React.FC = () => (
  <aside className="hidden lg:flex relative overflow-hidden flex-col items-start justify-center bg-accent-soft border-r border-accent-line px-14 xl:px-20">
    {/* A faint dot pattern in the brand blue, fading towards the form side. */}
    <div
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--color-accent-line)_1.2px,transparent_1.2px)] [background-size:22px_22px] [mask-image:linear-gradient(to_right,black,transparent_90%)]"
      aria-hidden
    />
    <div className="relative max-w-[420px] animate-enter">
      <img src="/logo.png" alt="" className="w-16 h-16 rounded-2xl ring-4 ring-white shadow-[var(--shadow-pop)]" />
      <h2 className="mt-7 text-[32px] font-semibold text-ink tracking-tight leading-tight">Quality Monitoring</h2>
      <p className="mt-2 text-[15px] text-ink-secondary">Quality checks for every machine, shift and job.</p>
    </div>
  </aside>
)
