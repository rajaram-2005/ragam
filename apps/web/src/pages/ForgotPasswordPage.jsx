import React, { useState } from 'react'
import { api } from '../api.js'
import { PASSWORD_MIN_LENGTH } from '../auth.js'
import { Banner, Button, Field } from '../components/ui.jsx'
import AuthLayout, { AuthLink } from './AuthLayout.jsx'

// The reset-password page, in the two steps a reset actually takes here.
//
// The honest constraint first: this product has no mail transport, so it cannot email a
// reset link, and a page that claimed otherwise would not be describing this product.
// What it can do is what it does — ask the Core for a single-use code, which the Core
// writes into its own protected data directory (and prints to its console if the operator
// asks it to), and then accept that code with a new password. Somebody who can read the
// Core host's data directory could already read the provider key, so this delivery channel
// widens no boundary the installation did not already have; it is stated on the page
// rather than left to be discovered at 2 a.m.
//
// The first step answers identically for an address that exists and one that does not, and
// this page shows the same thing either way. Turning a reset form into an account lookup
// service is the classic way to leak who uses a product.
//
// Each step is its own component. That is not decoration: the second step is only
// reachable after a state change, so a page rendered as one unit is a page whose confirm
// form no test ever sees — and the confirm form is the half that sets a password.

const STAGES = Object.freeze({ REQUEST: 'request', CONFIRM: 'confirm', DONE: 'done' })

/** Step one: ask this installation for a code. */
export function ResetRequestForm({ email, onEmail, busy, onSubmit }) {
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <Field label="Email address" hint="If an account uses it, a code will be waiting on the Core host.">
        <input
          autoFocus className="input" type="email" name="email" inputMode="email" autoComplete="username"
          required maxLength={254} placeholder="you@example.com" value={email}
          onChange={(event) => onEmail(event.target.value)} disabled={busy}
        />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!email}>Request a reset code</Button>
    </form>
  )
}

/** Step two: the code, and the password it unlocks. */
export function ResetConfirmForm({ code, onCode, password, onPassword, confirm, onConfirm, busy, onSubmit }) {
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <Field label="Reset code" hint="Single use, and it expires fifteen minutes after it was requested.">
        <input
          autoFocus className="input mono" type="text" name="code" autoComplete="one-time-code" spellCheck="false"
          required maxLength={256} value={code} onChange={(event) => onCode(event.target.value)} disabled={busy}
        />
      </Field>
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters, and not one this account has used.`}>
        <input
          className="input" type="password" name="password" autoComplete="new-password" required
          minLength={PASSWORD_MIN_LENGTH} maxLength={256} value={password}
          onChange={(event) => onPassword(event.target.value)} disabled={busy}
        />
      </Field>
      <Field label="Confirm new password">
        <input
          className="input" type="password" name="confirm-password" autoComplete="new-password" required
          maxLength={256} value={confirm} aria-invalid={mismatch || undefined}
          onChange={(event) => onConfirm(event.target.value)} disabled={busy}
        />
        {mismatch ? <span className="error-text">Those two passwords are not the same.</span> : null}
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!code || !password || mismatch}>Set new password</Button>
    </form>
  )
}

export default function ForgotPasswordPage({ error = null, onError = () => {} }) {
  const [stage, setStage] = useState(STAGES.REQUEST)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== password

  const requestCode = async (event) => {
    event.preventDefault()
    setBusy(true); onError(null); setMessage('')
    try {
      const result = await api.requestPasswordReset(email.trim())
      setMessage(result.message)
      setStage(STAGES.CONFIRM)
    } catch (failure) {
      onError(failure)
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async (event) => {
    event.preventDefault()
    if (mismatch) { onError(new Error('Those two passwords are not the same.')); return }
    setBusy(true); onError(null)
    try {
      const result = await api.confirmPasswordReset({ email: email.trim(), code: code.trim(), password })
      setPassword(''); setConfirm(''); setCode('')
      setMessage(result.message ?? 'Your password is changed. Sign in with the new one.')
      setStage(STAGES.DONE)
    } catch (failure) {
      onError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      active="forgot-password"
      title="Reset your password"
      subtitle="Two steps: ask this installation for a single-use code, then set a new password with it."
      error={error}
      footer="This installation sends no email. The reset code is delivered on the Core host, to whoever operates it."
    >
      {message ? <Banner tone="info" title={message} /> : null}

      {stage === STAGES.REQUEST
        ? <ResetRequestForm email={email} onEmail={setEmail} busy={busy} onSubmit={requestCode} />
        : null}

      {stage === STAGES.CONFIRM
        ? (
          <ResetConfirmForm
            code={code} onCode={setCode} password={password} onPassword={setPassword}
            confirm={confirm} onConfirm={setConfirm} busy={busy} onSubmit={resetPassword}
          />
        )
        : null}

      {stage === STAGES.DONE
        ? <div className="auth-row"><AuthLink page="signin">Go to sign in</AuthLink></div>
        : null}

      <p className="small auth-note">
        Where the code is: on the Core host, in <code>password-resets.json</code> inside the online data
        directory (mode 0600), and on the Core console when the operator started it with
        <code> AETHERIS_PRINT_RESET_CODES=true</code>. Changing a password ends every session for that
        account, including this one.
      </p>
    </AuthLayout>
  )
}
