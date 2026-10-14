import React, { useState } from 'react'
import { api } from '../api.js'
import { PASSWORD_RULES } from '../auth.js'
import { Button, Field } from '../components/ui.jsx'
import AuthLayout, { AuthLink } from './AuthLayout.jsx'

// The create-account page.
//
// Sign-up is open: anybody who can reach this installation can make an account on it.
// That is a deliberate choice and it has two consequences the page states instead of
// hiding. The first account created owns the installation and is the only one that can
// change its gateway connection, so whoever sets the product up keeps the keys; and
// every account chats through that one gateway, so its operator is paying for all of
// them. Both are said here, in the place where the decision is being made.
//
// The confirm field is a client-side convenience. It is not sent to the server, which
// takes one password and judges it by its own policy — a rule the client cannot weaken.

export default function SignUpPage({ checking = false, error = null, onError = () => {}, onSignedIn = () => {} }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== password

  return (
    <AuthLayout
      active="signup"
      title="Create your account"
      subtitle="An account is local to this Aetheris installation. There is no email verification and nothing is sent anywhere to create it."
      error={error}
    >
      <form
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault()
          if (mismatch) { onError(new Error('Those two passwords are not the same.')); return }
          setBusy(true); onError(null)
          try {
            const result = await api.register({ email: email.trim(), password })
            setPassword(''); setConfirm('')
            onSignedIn(result.account)
          } catch (failure) {
            onError(failure)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Email address" hint="Used to sign in. Stored on this host, never published by the API.">
          <input
            autoFocus className="input" type="email" name="email" inputMode="email"
            autoComplete="username" required maxLength={254} placeholder="you@example.com"
            value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy}
          />
        </Field>
        <Field label="Password">
          <input
            className="input" type="password" name="password" autoComplete="new-password"
            required minLength={12} maxLength={256} value={password}
            onChange={(event) => setPassword(event.target.value)} disabled={busy}
          />
        </Field>
        <ul className="auth-rules" aria-label="Password rules">
          {PASSWORD_RULES.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
        <Field label="Confirm password">
          <input
            className="input" type="password" name="confirm-password" autoComplete="new-password"
            required maxLength={256} value={confirm} aria-invalid={mismatch || undefined}
            onChange={(event) => setConfirm(event.target.value)} disabled={busy}
          />
          {mismatch ? <span className="error-text">Those two passwords are not the same.</span> : null}
        </Field>
        <Button type="submit" variant="primary" busy={busy || checking} disabled={!email || !password || mismatch}>Create account</Button>
        <div className="auth-row">
          <AuthLink page="signin">Already have an account? Sign in</AuthLink>
        </div>
      </form>
      <p className="small auth-note">
        The first account created on an installation becomes its <strong>owner</strong> and is the only one
        that can change the gateway connection or its key. Later accounts are members: they can chat, keep
        their own history, memory and knowledge, and use the gateway the owner configured.
      </p>
    </AuthLayout>
  )
}
