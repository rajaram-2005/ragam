import React, { useState } from 'react'
import { api } from '../api.js'
import { Button, Field } from '../components/ui.jsx'
import AuthLayout, { AuthLink } from './AuthLayout.jsx'

// The sign-in page: an email address and a password.
//
// `autoComplete="username"` and `autoComplete="current-password"` are not decoration.
// They are what lets a password manager recognise a traditional sign-in form and offer
// to fill it — which is also what stops people reusing a weak password they had to
// remember by hand. The fields keep their real names for the same reason.
//
// The password is cleared after a successful submit so it is not sitting in component
// state while the app renders somebody's workspace.

export default function SignInPage({ checking = false, error = null, onError = () => {}, onSignedIn = () => {} }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <AuthLayout
      active="signin"
      title="Sign in"
      subtitle="Chat, Image, Video, Plugins and MCP, through this installation's LiteLLM gateway."
      error={error}
    >
      <form
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true); onError(null)
          try {
            const result = await api.login({ email: email.trim(), password })
            setPassword('')
            onSignedIn(result.account)
          } catch (failure) {
            onError(failure)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Email address">
          <input
            autoFocus className="input" type="email" name="email" inputMode="email"
            autoComplete="username" required maxLength={254} placeholder="you@example.com"
            value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy}
          />
        </Field>
        <Field label="Password">
          <input
            className="input" type="password" name="password" autoComplete="current-password"
            required maxLength={256} value={password}
            onChange={(event) => setPassword(event.target.value)} disabled={busy}
          />
        </Field>
        <Button type="submit" variant="primary" busy={busy || checking} disabled={!email || !password}>Sign in</Button>
        <div className="auth-row">
          <AuthLink page="forgot-password">Forgot your password?</AuthLink>
        </div>
      </form>
    </AuthLayout>
  )
}
