import React, { useRef, useState } from 'react'
import { api } from '../api.js'
import { PASSWORD_MIN_LENGTH } from '../auth.js'
import { Banner, Button, Chip, Field } from './ui.jsx'

// Who is signed in, and the two things a person does with their own account: change
// their password and sign out.
//
// This lives in the sidebar rather than in a settings area because the product has
// exactly five areas and an account menu is not a sixth one. It is also the only place
// in the signed-in app where the account's own email address is shown, which makes
// "which of my accounts is this?" answerable at a glance on a shared installation.
//
// Changing a password asks for the current one, and the server drops every other session
// when it succeeds. The dialog says so, because being signed out elsewhere is otherwise
// indistinguishable from a bug.

export default function AccountCard({ account, onSignOut }) {
  const dialog = useRef(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const mismatch = confirm.length > 0 && confirm !== nextPassword

  if (!account) return null

  const close = () => {
    dialog.current?.close()
    setCurrentPassword(''); setNextPassword(''); setConfirm(''); setError(null); setNotice('')
  }
  const open = () => { setNotice(''); setError(null); if (!dialog.current?.open) dialog.current?.showModal() }

  const submit = async (event) => {
    event.preventDefault()
    if (mismatch) { setError(new Error('Those two passwords are not the same.')); return }
    setBusy(true); setError(null); setNotice('')
    try {
      await api.changePassword({ currentPassword, newPassword: nextPassword })
      setNotice('Password changed. Your other sessions were signed out.')
      setCurrentPassword(''); setNextPassword(''); setConfirm('')
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="account-card">
      <div className="account-identity">
        <span className="account-email" title={account.email}>{account.email}</span>
        <Chip
          tone={account.role === 'owner' ? 'violet' : 'info'}
          title={account.role === 'owner'
            ? 'This account owns the installation and its gateway connection.'
            : 'This account can use the gateway the owner configured.'}
        >
          {account.role === 'owner' ? 'OWNER' : 'MEMBER'}
        </Chip>
      </div>
      <div className="account-actions">
        <button className="btn small" type="button" onClick={open}>Change password</button>
        <button className="btn small" type="button" onClick={onSignOut}>Sign out</button>
      </div>

      <dialog
        className="provider-dialog"
        ref={dialog}
        onCancel={(event) => { event.preventDefault(); if (!busy) close() }}
        aria-labelledby="change-password-title"
      >
        <div className="row between">
          <h2 id="change-password-title">Change password</h2>
          <Button disabled={busy} onClick={close}>Close</Button>
        </div>
        <p className="small">Your current password is required. Changing it signs out every other session for {account.email}.</p>
        {error ? <Banner tone="bad" title={error.message ?? String(error)} /> : null}
        {notice ? <Banner tone="ok" title={notice} /> : null}
        <form onSubmit={submit}>
          <Field label="Current password">
            <input
              autoFocus className="input" type="password" name="current-password" autoComplete="current-password"
              required maxLength={256} value={currentPassword} disabled={busy}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
            <input
              className="input" type="password" name="new-password" autoComplete="new-password" required
              minLength={PASSWORD_MIN_LENGTH} maxLength={256} value={nextPassword} disabled={busy}
              onChange={(event) => setNextPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <input
              className="input" type="password" name="confirm-password" autoComplete="new-password" required
              maxLength={256} value={confirm} aria-invalid={mismatch || undefined} disabled={busy}
              onChange={(event) => setConfirm(event.target.value)}
            />
            {mismatch ? <span className="error-text">Those two passwords are not the same.</span> : null}
          </Field>
          <Button type="submit" variant="primary" busy={busy} disabled={!currentPassword || !nextPassword || mismatch}>Change password</Button>
        </form>
      </dialog>
    </div>
  )
}
