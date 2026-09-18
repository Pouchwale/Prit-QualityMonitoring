import React, { useState } from 'react'
import { useAuth } from '../lib/auth'
import { API_URL, errorText } from '../lib/api'
import { Button } from '../components/common/Button'
import { Field, FormError, TextInput } from '../components/common/Form'

export const LoginPage: React.FC = () => {
  const { login } = useAuth()
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(employeeId.trim(), password)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-6">
          <img src="/logo.png" alt="" className="w-10 h-10 rounded-[10px]" />
          <div>
            <div className="text-sm font-semibold text-ink leading-none">Quality Monitoring</div>
            <div className="text-[11px] text-ink-muted mt-1">Admin Panel</div>
          </div>
        </div>

        <form onSubmit={submit} className="bg-white border border-line rounded-lg p-6 space-y-4">
          <div>
            <h1 className="text-lg font-bold text-ink tracking-tight">Sign in</h1>
            <p className="text-xs text-ink-muted mt-0.5">For administrators and quality managers.</p>
          </div>

          <FormError message={error} />

          <Field label="Employee ID">
            <TextInput
              autoFocus
              autoComplete="username"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="e.g. ADMIN"
              className="h-9 text-sm"
            />
          </Field>

          <Field label="Password">
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={!employeeId || !password}>
            Sign in
          </Button>
        </form>

        <p className="text-[11px] text-ink-faint text-center mt-4 font-mono">API: {API_URL}</p>
      </div>
    </div>
  )
}
