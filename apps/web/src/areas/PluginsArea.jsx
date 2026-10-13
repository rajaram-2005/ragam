import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Kv, Panel, Stat, Stats, Table } from '../components/ui.jsx'

// ---------------------------------------------------------------------------
// Plugins.
//
// Permission boundaries are the product here, so the interface shows them before
// anything is invoked: declared scopes, which of them are elevated, whether a
// handler is actually bound, and the preflight verdict with its reasons verbatim.
//
// Preflight answers a question and therefore returns 200 with allowed:false;
// invoke must fail. Both paths are rendered distinctly so "denied" is never
// mistaken for "broken".
// ---------------------------------------------------------------------------

const SAMPLE_MANIFEST = {
  manifestVersion: 1,
  id: 'demo.texttools',
  name: 'Demo Text Tools',
  version: '1.0.0',
  protocol: 'local_tool',
  description: 'Development fixture: counts words in a string. Requests no scopes.',
  author: 'aetheris',
  license: 'MIT',
  scopes: [],
  capabilities: [
    {
      name: 'count.words',
      description: 'Count the words in the supplied text.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}

function ScopeChips({ scopes, elevated = [] }) {
  if (!scopes?.length) return <span className="muted small">no scopes declared</span>
  return (
    <div className="row" style={{ gap: 4 }}>
      {scopes.map((scope) => (
        <Chip key={scope} tone={elevated.includes(scope) ? 'warn' : 'info'} dot={false}>
          {scope}
        </Chip>
      ))}
    </div>
  )
}

function PluginDetail({ plugin, onChanged, busy, setBusy, setError }) {
  const [capability, setCapability] = useState('')
  const [input, setInput] = useState('{}')
  const [approvals, setApprovals] = useState([])
  const [preflight, setPreflight] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    setCapability(plugin?.capabilities?.[0]?.name ?? '')
    setPreflight(null)
    setResult(null)
    setApprovals([])
  }, [plugin?.id])

  if (!plugin) {
    return <EmptyState title="No plugin selected">Choose a plugin from the registry to inspect its scopes, capabilities and audit history.</EmptyState>
  }

  const selected = plugin.capabilities?.find((entry) => entry.name === capability) ?? null

  const runPreflight = async () => {
    setBusy('preflight')
    setError(null)
    setPreflight(null)
    try {
      setPreflight(await api.pluginPreflight(plugin.id, capability, { approvals }))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const runInvoke = async () => {
    setBusy('invoke')
    setError(null)
    setResult(null)
    try {
      let parsed = {}
      try {
        parsed = input.trim() ? JSON.parse(input) : {}
      } catch {
        throw Object.assign(new Error('the input field is not valid JSON'), { code: 'invalid_input' })
      }
      setResult(await api.pluginInvoke(plugin.id, capability, parsed, { approvals, subject: plugin.id }))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
      onChanged?.()
    }
  }

  const act = async (action) => {
    setBusy(action)
    setError(null)
    try {
      await api.setPluginState(plugin.id, action)
      onChanged?.()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid" style={{ gap: 13 }}>
      <div className="row">
        <Chip>{plugin.state}</Chip>
        <Chip tone="violet" dot={false}>{plugin.protocol}</Chip>
        <Chip dot={false}>v{plugin.version}</Chip>
        {plugin.builtin ? <Chip tone="info">built-in</Chip> : null}
        {plugin.previousVersion ? <Chip tone="warn" dot={false}>updated from {plugin.previousVersion}</Chip> : null}
      </div>

      <Kv
        entries={{
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          author: plugin.author,
          license: plugin.license,
          invocations: plugin.invocations,
          failures: plugin.failures,
        }}
      />

      <div className="grid" style={{ gap: 6 }}>
        <span className="panel-eyebrow">DECLARED SCOPES</span>
        <ScopeChips scopes={plugin.scopes} elevated={plugin.elevated} />
        {plugin.elevated?.length ? (
          <span className="small muted">Elevated scopes always require an explicit per-call approval.</span>
        ) : null}
      </div>

      <div className="row">
        {plugin.state === 'enabled' ? (
          <Button busy={busy === 'disable'} onClick={() => act('disable')}>Disable</Button>
        ) : (
          <Button busy={busy === 'enable'} onClick={() => act('enable')} disabled={plugin.state === 'uninstalled'}>Enable</Button>
        )}
        <Button busy={busy === 'uninstall'} onClick={() => act('uninstall')} disabled={plugin.builtin}>
          Uninstall
        </Button>
        {plugin.builtin ? <span className="small muted">Built-in plugins ship with the product and cannot be uninstalled; the refusal is audited.</span> : null}
        <span className="small muted">Uninstalling keeps an auditable record; it does not erase history.</span>
      </div>

      <Field label="Capability">
        <select className="select" value={capability} onChange={(event) => setCapability(event.target.value)}>
          {(plugin.capabilities ?? []).map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
              {entry.bound ? '' : ' — no handler bound'}
            </option>
          ))}
        </select>
      </Field>

      {selected ? (
        <div className="grid" style={{ gap: 6 }}>
          <span className="small soft">{selected.description}</span>
          <div className="row">
            <Chip tone={selected.bound ? 'ok' : 'bad'}>{selected.bound ? 'handler bound' : 'no handler'}</Chip>
            <Chip tone={selected.readOnly ? 'ok' : 'warn'} dot={false}>{selected.readOnly ? 'read-only' : 'may write'}</Chip>
            <ScopeChips scopes={selected.requiredScopes} elevated={selected.requiredScopes?.filter((scope) => (plugin.elevated ?? []).includes(scope)) ?? []} />
          </div>
        </div>
      ) : null}

      {(selected?.requiredScopes ?? []).filter((scope) => (plugin.elevated ?? []).includes(scope)).length ? (
        <div className="grid" style={{ gap: 6 }}>
          <span className="panel-eyebrow">APPROVE ELEVATED SCOPES FOR THIS CALL</span>
          {selected.requiredScopes
            .filter((scope) => (plugin.elevated ?? []).includes(scope))
            .map((scope) => (
              <label className="checkbox" key={scope}>
                <input
                  type="checkbox"
                  checked={approvals.includes(scope)}
                  onChange={(event) => setApprovals((previous) => (event.target.checked ? [...previous, scope] : previous.filter((entry) => entry !== scope)))}
                />
                {scope}
              </label>
            ))}
        </div>
      ) : null}

      <Field label="Input (JSON)" hint="Validated against the capability’s declared inputSchema before the handler runs.">
        <textarea className="textarea" value={input} onChange={(event) => setInput(event.target.value)} spellCheck={false} />
      </Field>

      <div className="row">
        <Button busy={busy === 'preflight'} onClick={runPreflight} disabled={!capability}>Preflight</Button>
        <Button variant="primary" busy={busy === 'invoke'} onClick={runInvoke} disabled={!capability}>Invoke</Button>
      </div>

      {preflight ? (
        <Banner tone={preflight.allowed ? 'ok' : 'warn'} title={preflight.allowed ? 'Preflight allows this call' : 'Preflight does not allow this call'}>
          {preflight.reasons?.length ? <ul>{preflight.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
          <div className="row" style={{ marginTop: 6 }}>
            <Chip tone={preflight.readOnly ? 'ok' : 'warn'} dot={false}>{preflight.readOnly ? 'read-only' : 'may write'}</Chip>
            {preflight.timeoutMs ? <Chip dot={false}>timeout {preflight.timeoutMs} ms</Chip> : null}
            {preflight.needsApproval?.length ? <Chip tone="warn" dot={false}>needs {preflight.needsApproval.join(', ')}</Chip> : null}
          </div>
        </Banner>
      ) : null}

      {result ? <Code label="INVOCATION RESULT" value={result} /> : null}
      {plugin.history?.length ? <Code label="INSTALL HISTORY" value={plugin.history} /> : null}
    </div>
  )
}

/**
 * Trusted publishers: the keys this host will accept a signature from.
 *
 * The scope is on the panel, not in a tooltip: a signature says who published a manifest,
 * and nothing about whether the code is safe. A plugin still runs only with the permissions
 * that were granted to it, which is why this sits beside the scope controls rather than
 * above them. Nothing is fetched — a key is trusted because someone pasted it here.
 */
function TrustedPublishers() {
  const [state, setState] = useState(null)
  const [pem, setPem] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      setState(await api.trustedKeys())
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const add = async (event) => {
    event.preventDefault()
    if (!pem.trim()) return
    setBusy('add')
    setError(null)
    setNotice(null)
    try {
      const result = await api.trustKey({ pem: pem.trim(), label: label.trim() })
      setNotice(result.added ? `Trusted ${result.keyId}.` : `${result.keyId} was already trusted.`)
      setPem('')
      setLabel('')
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (keyId) => {
    setBusy(`del-${keyId}`)
    setError(null)
    try {
      await api.untrustKey(keyId)
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const keys = state?.keys ?? []

  return (
    <Panel
      eyebrow="INTERNAL SERVICE"
      title="Trusted publishers"
      footer="A signature says which key signed a manifest. It does not say the code is safe: a plugin still runs only with the scopes you grant it. Removing a key stops future installs; it does not uninstall what is already here."
    >
      <div className="grid" style={{ gap: 14 }}>
        {error ? <ErrorNote error={error} title="Trust store request failed" /> : null}
        {notice ? <Banner tone="ok" title="Done"><span className="small">{notice}</span></Banner> : null}

        <Stats>
          <Stat
            label="signatures"
            value={state?.signaturesRequired ? 'required' : 'optional'}
            note={state?.signaturesRequired ? 'an unsigned plugin is refused' : 'unsigned manifests still install'}
          />
          <Stat label="trusted keys" value={keys.length} note="used to check plugin signatures" />
        </Stats>

        {state && !state.signaturesRequired ? (
          <span className="small">
            Signatures are optional on this host, so an unsigned plugin can still be installed. A manifest carrying a
            signature from an untrusted key is refused either way — that is a claim this host cannot check.
          </span>
        ) : null}

        <form onSubmit={add}>
          <Field label="Trust a publisher key" hint="A public key in PEM form. Private keys are refused, and nothing is fetched from the network.">
            <textarea
              className="textarea"
              rows={4}
              value={pem}
              placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
              onChange={(event) => setPem(event.target.value)}
            />
          </Field>
          <div className="row between">
            <input className="input" value={label} placeholder="who this key belongs to" onChange={(event) => setLabel(event.target.value)} />
            <Button type="submit" variant="primary" busy={busy === 'add'} disabled={!pem.trim()}>Trust this key</Button>
          </div>
        </form>

        {keys.length ? (
          <Table
            columns={[
              { key: 'keyId', label: 'Key', render: (key) => <span className="small">{key.keyId}</span> },
              { key: 'label', label: 'Label', render: (key) => key.label || <span className="small">unlabelled</span> },
              { key: 'actions', label: '', render: (key) => (
                <Button variant="danger" busy={busy === `del-${key.keyId}`} onClick={() => remove(key.keyId)}>Stop trusting</Button>
              ) },
            ]}
            rows={keys.map((key) => ({ ...key, key: key.keyId }))}
          />
        ) : (
          <EmptyState title="No publisher keys are trusted">
            <span className="small">
              Plugin manifests can still be installed, but this host cannot check who published them. Add a key to
              accept signed manifests from that publisher.
            </span>
          </EmptyState>
        )}
      </div>
    </Panel>
  )
}

export default function PluginsArea({ refreshReadiness }) {
  const [plugins, setPlugins] = useState([])
  const [catalog, setCatalog] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [manifestText, setManifestText] = useState(JSON.stringify(SAMPLE_MANIFEST, null, 2))
  const [validation, setValidation] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      const [pluginPayload, capabilityPayload] = await Promise.all([api.plugins(), api.pluginCapabilities()])
      setPlugins(pluginPayload.plugins ?? [])
      setCatalog(capabilityPayload)
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? null

  const parseManifest = () => {
    try {
      return { manifest: JSON.parse(manifestText), error: null }
    } catch (caught) {
      return { manifest: null, error: Object.assign(new Error(`manifest is not valid JSON: ${caught.message}`), { code: 'invalid_json' }) }
    }
  }

  const validate = async () => {
    setBusy('validate')
    setError(null)
    setValidation(null)
    setNotice(null)
    const { manifest, error: parseError } = parseManifest()
    if (parseError) {
      setError(parseError)
      setBusy(null)
      return
    }
    try {
      setValidation(await api.validateManifest({ manifest }))
      setNotice('Manifest validated. Nothing was installed yet.')
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const install = async () => {
    setBusy('install')
    setError(null)
    setValidation(null)
    setNotice(null)
    const { manifest, error: parseError } = parseManifest()
    if (parseError) {
      setError(parseError)
      setBusy(null)
      return
    }
    try {
      const result = await api.installPlugin({ manifest })
      const installed = result.plugin ?? result
      setNotice(
        result.reinstalled
          ? `${installed.id ?? manifest.id} reinstalled at ${installed.version ?? manifest.version}.`
          : `${installed.id ?? manifest.id}@${installed.version ?? manifest.version} installed in state '${installed.state ?? 'installed'}'. It is not enabled and no handler is bound until the server binds one.`,
      )
      setSelectedId(installed.id ?? manifest.id)
      await load()
      refreshReadiness?.()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="split">
      <div className="grid" style={{ gap: 16 }}>
        <Panel
          eyebrow="PRODUCT AREA"
          title="Plugin registry"
          actions={<Button busy={busy === 'load'} onClick={load}>Refresh</Button>}
          tight
        >
          <Table
            columns={[
              { key: 'state', label: 'State', render: (plugin) => <Chip>{plugin.state}</Chip> },
              { key: 'id', label: 'Plugin', render: (plugin) => <strong>{plugin.name ?? plugin.id}</strong> },
              { key: 'version', label: 'Version', render: (plugin) => <span className="small">{plugin.version}</span> },
              { key: 'protocol', label: 'Protocol', render: (plugin) => <Chip tone="violet" dot={false}>{plugin.protocol}</Chip> },
              { key: 'scopes', label: 'Scopes', render: (plugin) => <ScopeChips scopes={plugin.scopes} elevated={plugin.elevated} /> },
              { key: 'calls', label: 'Calls', render: (plugin) => <span className="small">{plugin.invocations ?? 0} / {plugin.failures ?? 0} fail</span> },
              { key: 'open', label: '', render: (plugin) => <Button onClick={() => setSelectedId(plugin.id)}>Inspect</Button> },
            ]}
            rows={plugins.map((plugin) => ({ ...plugin, key: plugin.id }))}
            empty="No plugins installed. Install one from a validated manifest on the right."
          />
        </Panel>

        <Panel eyebrow="INSPECTION" title="Plugin detail and invocation">
          <PluginDetail
            plugin={selected}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChanged={async () => {
              await load()
              refreshReadiness?.()
            }}
          />
        </Panel>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        {error ? <ErrorNote error={error} title="Plugin request failed" /> : null}
        {notice ? <Banner tone="ok" title="Done"><span className="small">{notice}</span></Banner> : null}

        <Panel
          eyebrow="INSTALLATION"
          title="Validate and install a manifest"
          actions={
            <>
              <Button busy={busy === 'validate'} onClick={validate}>Validate</Button>
              <Button variant="primary" busy={busy === 'install'} onClick={install}>Install</Button>
            </>
          }
          footer="An invalid manifest is rejected with every problem listed. A valid one installs as disabled: installation is not authorisation."
        >
          <div className="grid" style={{ gap: 12 }}>
            <Field label="Manifest (JSON)" hint="The sample below is a development fixture — it declares no scopes and has no handler bound on this server.">
              <textarea
                className="textarea"
                style={{ minHeight: 240, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
                value={manifestText}
                spellCheck={false}
                onChange={(event) => setManifestText(event.target.value)}
              />
            </Field>
            <div className="row">
              <span className="small muted">The sample manifest is marked as a fixture because no server-side handler implements it here.</span>
              <span className="chip" style={{ borderColor: 'rgba(201,167,86,.45)', color: 'var(--gold)' }}>development fixture</span>
            </div>
            {validation ? <Code label="VALIDATION RESULT" value={validation} /> : null}
          </div>
        </Panel>

        <Panel eyebrow="INTERNAL SERVICE" title="Permission model" footer="Scopes are an allowlist. Anything undeclared is denied at invocation time, and the denial is audited.">
          <div className="grid" style={{ gap: 12 }}>
            <Stats>
              <Stat label="plugins" value={plugins.length} />
              <Stat label="enabled" value={plugins.filter((plugin) => plugin.state === 'enabled').length} />
              <Stat label="invocations" value={plugins.reduce((total, plugin) => total + (plugin.invocations ?? 0), 0)} />
              <Stat label="failures" value={plugins.reduce((total, plugin) => total + (plugin.failures ?? 0), 0)} />
            </Stats>
            <div className="grid" style={{ gap: 6 }}>
              <span className="panel-eyebrow">KNOWN SCOPES</span>
              <ScopeChips scopes={catalog?.scopes ?? []} elevated={catalog?.elevated ?? []} />
            </div>
            {catalog?.forbidden?.length ? (
              <Banner tone="bad" title="Scopes that can never be granted" items={catalog.forbidden} />
            ) : null}
            {catalog?.protocols?.length ? (
              <div className="grid" style={{ gap: 6 }}>
                <span className="panel-eyebrow">PROTOCOLS</span>
                <ScopeChips scopes={catalog.protocols} />
              </div>
            ) : null}
          </div>
        </Panel>

        <TrustedPublishers />
      </div>
    </div>
  )
}
