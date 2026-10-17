import React from 'react'

// What this build can actually reach, shown next to the connection it reaches.
//
// The distinction this component exists to make visible: a provider being *listed* is not a
// provider being *supported*. Three statuses, three sentences, no controls — because there is
// nothing here a user can switch on that would work, and a disabled control is still a promise.
//
// `ready`       a tested code path reaches it. The capability list is what the tests exercise.
// `gateway_only` it speaks the OpenAI-compatible wire this build implements; it has not been
//               verified against this vendor, and the row says so.
// `pending`     no adapter exists. Collapsed, not selectable, and listed only so the matrix is
//               honest about the rest of the market rather than implying it does not exist.

const STATUS_TEXT = {
  ready: 'ready in this build',
  gateway_only: 'reachable via a compatible endpoint, not verified here',
  pending: 'adapter pending; not selectable',
}

export default function ProviderCatalogue({ catalog }) {
  if (!catalog || !Array.isArray(catalog.providers) || catalog.providers.length === 0) return null
  const reachable = catalog.providers.filter((provider) => provider.status !== 'pending')
  const pending = catalog.providers.filter((provider) => provider.status === 'pending')
  return <details className="provider-catalogue" style={{ marginTop: 20 }}>
    <summary>Provider support — {catalog.summary}</summary>
    <p className="small">
      Listed is not supported. “Ready” means a tested code path reaches it; “via a compatible
      endpoint” means the wire format is implemented and this build has not verified the vendor;
      pending adapters cannot be selected. No entry here adds a provider to this installation.
    </p>
    <ul className="small" aria-label="Reachable providers">
      {reachable.map((provider) => <li key={provider.id}>
        <strong>{provider.label}</strong> — {STATUS_TEXT[provider.status]}
        {provider.capabilities.length ? ` (tested: ${provider.capabilities.map((capability) => capability.id).join(', ')})` : ''}
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
