import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Field, Panel, Table } from './ui.jsx'

export default function ModelCatalog() {
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [authorizeNetwork, setAuthorizeNetwork] = useState(false)
  useEffect(() => { api.modelCatalog().then(setCatalog).catch(setError) }, [])
  const load = async (sourceId = null) => {
    setBusy(true)
    setError(null)
    try {
      if (sourceId) await api.refreshCatalog(sourceId, authorizeNetwork)
      setCatalog(await api.modelCatalog(query))
    } catch (caught) {
      setError(caught)
      // Show last-good records as stale after a failed refresh, not as fresh.
      try { setCatalog(await api.modelCatalog(query)) } catch { /* retain view */ }
    } finally { setBusy(false) }
  }
  return (
    <Panel eyebrow="INTERNAL SERVICE" title="Model catalog" footer="Discovery only. Listings do not install models, approve licences, authorize inference, or make a model ready. Showing at most 100 results; search to narrow them.">
      <form onSubmit={(event) => { event.preventDefault(); void load() }}>
        <Field label="Search cached model metadata" hint="Search stays in Core; it does not query a remote catalog.">
          <input className="input" value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <Button type="submit" busy={busy}>Search catalog</Button>
      </form>
      <label className="small"><input type="checkbox" checked={authorizeNetwork} onChange={(event) => setAuthorizeNetwork(event.target.checked)} /> Authorize external metadata refresh only — not inference or uploads of my work</label>
      {catalog?.sources?.map((source) => (
        <div key={source.id} className="small">
          {source.id} · {source.recordCount} records · {source.stale ? 'stale / not refreshed' : 'cached'} · {source.coverage ?? 'coverage unknown'}
          {source.lastError ? ` · ${source.lastError}` : ''}
          <Button disabled={busy || (source.network === 'external' && !authorizeNetwork)} onClick={() => load(source.id)}>Refresh {source.id}</Button>
        </div>
      ))}
      {error ? <Banner tone="warn" title={error.message}>{error.code}</Banner> : null}
      <Table columns={[
        { key: 'id', label: 'Model' },
        { key: 'sourceId', label: 'Source' },
        { key: 'revision', label: 'Revision', render: (row) => row.revision ?? 'unknown' },
        { key: 'tasks', label: 'Declared tasks', render: (row) => row.tasks.join(', ') || 'unknown' },
        { key: 'licence', label: 'Licence', render: (row) => `${row.licence.id ?? 'unknown'} — not reviewed` },
        { key: 'stale', label: 'Metadata', render: (row) => row.stale ? 'stale' : 'catalog only' },
      ]} rows={catalog?.records ?? []} empty="No cached catalog records. Configure sources on the Core host; no automatic upstream refresh occurs." />
    </Panel>
  )
}
