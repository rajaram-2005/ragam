import React, { useEffect, useRef, useState } from 'react'
import { Banner, Button, Field } from './ui.jsx'
import { normalizeProfile } from '../profile.js'

export default function ProfileSettings({ profile, onSave, onClose }) {
  const dialog = useRef(null)
  const [name, setName] = useState(profile?.name ?? '')
  const [profession, setProfession] = useState(profile?.profession ?? '')
  const [error, setError] = useState('')

  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
  }, [])

  const close = () => {
    dialog.current?.close()
    onClose?.()
  }

  const save = (event) => {
    event.preventDefault()
    const next = normalizeProfile({ name, profession })
    try {
      onSave?.(next)
      close()
    } catch (failure) {
      setError(failure?.message ?? 'The profile could not be saved in this browser.')
    }
  }

  const clear = () => {
    try {
      onSave?.({ name: '', profession: '' })
      close()
    } catch (failure) {
      setError(failure?.message ?? 'The profile could not be cleared in this browser.')
    }
  }

  return <dialog className="provider-dialog profile-dialog" ref={dialog} onCancel={(event) => { event.preventDefault(); close() }} aria-labelledby="profile-settings-title">
    <div className="row between">
      <div>
        <h2 id="profile-settings-title">Personalize recommendations</h2>
        <p className="small">Tell Ragam your name and profession or role.</p>
      </div>
      <Button type="button" onClick={close}>Close</Button>
    </div>
    {error ? <Banner tone="bad" title={error} /> : null}
    <form onSubmit={save}>
      <Field label="Name" hint="Optional. Used only for a greeting in this browser.">
        <input className="input" type="text" autoComplete="given-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
      </Field>
      <Field label="Profession or role" hint="For example: teacher, software developer, student, designer, or your own wording.">
        <input className="input" type="text" autoComplete="organization-title" maxLength={100} value={profession} onChange={(event) => setProfession(event.target.value)} placeholder="Your profession or role" />
      </Field>
      <p className="profile-privacy-note">Your profile is saved in this browser only; it is not transmitted on its own and is not included in Docker backups. Suggestions are profession-based prompt ideas, not model rankings. A suggestion may place your profession in the draft; nothing is sent until you press Send, and then the draft goes to the selected provider.</p>
      <div className="row between profile-actions">
        <Button type="button" className="ghost" onClick={clear}>Clear profile</Button>
        <Button type="submit" variant="primary">Save profile</Button>
      </div>
    </form>
  </dialog>
}
