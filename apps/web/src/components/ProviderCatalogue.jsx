import React from 'react'

// What this build can actually reach, shown next to the connection it reaches.
//
// The distinction this component exists to make visible: a provider being *listed* is not a
// provider being *supported*. Three statuses, three sentences, no controls — because there is
// nothing here a user can switch on that would work, and a disabled control is still a promise.
//
// `ready`       a tested code path reaches it. The capability list is what the tests exercise.
// `gateway_only` an individual contract adapter is fixture-tested; no live vendor qualification is implied.
// `pending`     no adapter exists. Collapsed, not selectable, and listed only so the matrix is
//               honest about the rest of the market rather than implying it does not exist.

const STATUS_TEXT = {
  ready: 'ready in this build',
  gateway_only: 'adapter contract-tested; live vendor verification pending',
  pending: 'adapter pending; not selectable',
}

export default function ProviderCatalogue({ catalog }) {
  if (!catalog || !Array.isArray(catalog.providers) || catalog.providers.length === 0) return null
  const reachable = catalog.providers.filter((provider) => provider.status !== 'pending')
  const pending = catalog.providers.filter((provider) => provider.status === 'pending')
  return <details className="provider-catalogue" style={{ marginTop: 20 }}>
    <summary>Provider support — {catalog.summary}</summary>
    <p className="small">
      The integration class distinguishes native vendor APIs, OpenAI-compatible APIs, and gateway-routed APIs. “Contract-tested” refers only to deterministic fixtures; “live verification pending” means no authorized call against that provider/model was performed. Model-list metadata is not inference verification, and model capabilities remain unknown unless evidenced by vendor metadata.
    </p>
    <ul className="small" aria-label="Reachable providers">
      {reachable.map((provider) => <li key={provider.id}>
        <strong>{provider.label}</strong> — {STATUS_TEXT[provider.status]}
        {provider.integrationType ? ` · ${provider.integrationType.replaceAll('-', ' ')}` : ''}
        {provider.adapterStatus ? ` · ${provider.adapterStatus}` : ''}
        {provider.liveVerification ? ` · live: ${provider.liveVerification}` : ''}
        {provider.capabilities.length ? ` (tested: ${provider.capabilities.map((capability) => capability.id).join(', ')})` : ''}
        {provider.docsUrl ? <> · <a href={provider.docsUrl} target="_blank" rel="noreferrer">official API docs</a></> : null}
      </li>)}
    </ul>
    {pending.length ? <details>
      <summary>{pending.length} pending adapters</summary>
      <ul className="small" aria-label="Pending providers">
        {pending.map((provider) => <li key={provider.id}>
          <strong>{provider.label}</strong> — {STATUS_TEXT.pending}
        </li>)}
      </ul>
    </details> : null}
    <p className="small">
      Model lists are not shown here on purpose: which models an account can use is a fact about a
      connection, and the connection is configured above.
    </p>
  </details>
}
