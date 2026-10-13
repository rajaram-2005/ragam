import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEgressGuard,
  installGlobalEgressGuard,
  createDataPolicy,
  RUNTIME_POLICIES,
  DATA_CLASSES,
  EgressBlockedError,
} from '../src/policy/egress.mjs'
import { classifyText, redactSecrets, redactDeep, looksLikeSourceCode } from '../src/policy/classify.mjs'

// A fake fetch that records every URL it was asked for. It must never be reached
// for a blocked target — that is the whole point of these tests.
function fakeFetch() {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, url: String(url) }
  }
  fn.calls = calls
  return fn
}

test('strict_offline blocks every external host', () => {
  const fetch = fakeFetch()
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch })
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://api.example.com/v1/models',
    'http://example.internal.corp/api',
    'https://huggingface.co/api/models',
  ]) {
    assert.equal(guard.inspect(url).allowed, false, `${url} should be blocked`)
  }
  assert.equal(fetch.calls.length, 0, 'no external request may be attempted')
  assert.equal(guard.offlineEnforced, true)
})

test('strict_offline still permits loopback providers', async () => {
  const fetch = fakeFetch()
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch })
  for (const url of ['http://127.0.0.1:11434/api/tags', 'http://localhost:8080/v1/models', 'http://[::1]:9000/x']) {
    assert.equal(guard.inspect(url).allowed, true, `${url} should be allowed`)
  }
  await guard.fetch('http://127.0.0.1:11434/api/tags')
  assert.deepEqual(fetch.calls, ['http://127.0.0.1:11434/api/tags'])
})

test('private-range literals count as local, but arbitrary hostnames do not', () => {
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch: fakeFetch() })
  assert.equal(guard.inspect('http://192.168.1.50:11434/api/tags').allowed, true)
  assert.equal(guard.inspect('http://10.0.0.9/v1/models').allowed, true)
  // A LAN *hostname* is not implicitly trusted; it needs an explicit allowlist entry.
  assert.equal(guard.inspect('http://ollama-box.lan/api/tags').allowed, false)
  const allowlisted = createEgressGuard({
    policy: RUNTIME_POLICIES.STRICT_OFFLINE,
    localAllowlist: ['ollama-box.lan'],
    fetch: fakeFetch(),
  })
  assert.equal(allowlisted.inspect('http://ollama-box.lan/api/tags').allowed, true)
})

test('a named internal host is not a strict_offline escape hatch', () => {
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch: fakeFetch() })
  // DNS-style names that merely look internal must still be blocked.
  assert.equal(guard.inspect('http://internal/api').allowed, false)
  assert.equal(guard.inspect('http://localhost.evil.com/api').allowed, false)
})

test('non-http protocols are refused in every policy', () => {
  for (const policy of Object.values(RUNTIME_POLICIES)) {
    const guard = createEgressGuard({ policy, fetch: fakeFetch() })
    for (const url of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host/']) {
      assert.equal(guard.inspect(url).allowed, false, `${policy} should refuse ${url}`)
    }
  }
})

test('unparseable URLs are refused rather than passed through', async () => {
  const fetch = fakeFetch()
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch })
  await assert.rejects(() => guard.fetch('not a url at all'), EgressBlockedError)
  assert.equal(fetch.calls.length, 0)
})

test('hybrid permits only allowlisted external hosts', () => {
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.HYBRID,
    onlineAllowlist: ['gateway.example.com'],
    fetch: fakeFetch(),
  })
  assert.equal(guard.inspect('https://gateway.example.com/v1/chat/completions').allowed, true)
  const denied = guard.inspect('https://api.openai.com/v1/chat/completions')
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /allowlist/)
})

test('online_enabled still enforces the allowlist', () => {
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.ONLINE_ENABLED,
    onlineAllowlist: ['gateway.example.com'],
    fetch: fakeFetch(),
  })
  assert.equal(guard.inspect('https://gateway.example.com/v1/models').allowed, true)
  assert.equal(guard.inspect('https://tracker.example.net/collect').allowed, false)
})

test('the global fetch hook blocks code that bypasses the guard object', async () => {
  // This is the test that distinguishes "blocked" from "hidden in the UI":
  // even a direct globalThis.fetch('https://…') must fail under strict_offline.
  const fetch = fakeFetch()
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch })
  const restore = installGlobalEgressGuard(guard)
  try {
    await assert.rejects(() => globalThis.fetch('https://api.openai.com/v1/models'), EgressBlockedError)
    await globalThis.fetch('http://127.0.0.1:11434/api/tags')
    assert.deepEqual(fetch.calls, ['http://127.0.0.1:11434/api/tags'])
  } finally {
    restore()
  }
  assert.equal(fetch.calls.length, 1, 'restore must not leave the hook installed')
})

test('every egress decision is auditable', () => {
  const decisions = []
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.HYBRID,
    onlineAllowlist: ['gateway.example.com'],
    fetch: fakeFetch(),
    onDecision: (event) => decisions.push(event),
  })
  guard.inspect('https://gateway.example.com/v1/models')
  guard.inspect('https://blocked.example.com/v1/models')
  assert.equal(decisions.length, 0, 'inspect() alone does not emit; fetch() does')
  return guard
    .fetch('https://blocked.example.com/v1/models')
    .catch(() => {})
    .then(() => {
      assert.equal(decisions.length, 1)
      assert.equal(decisions[0].allowed, false)
      assert.equal(decisions[0].scope, 'external')
    })
})

test('unknown policies are rejected at construction', () => {
  assert.throws(() => createEgressGuard({ policy: 'yolo', fetch: fakeFetch() }), TypeError)
})

test('data policy: confidential material needs explicit authorization to leave', () => {
  const policy = createDataPolicy({ externalCeiling: DATA_CLASSES.INTERNAL })
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.PUBLIC).allowed, true)
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.INTERNAL).allowed, true)

  const confidential = policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL)
  assert.equal(confidential.allowed, false)
  assert.match(confidential.reason, /exceeds the external ceiling/)

  // A blanket "yes" is not enough: the authorization must name the class.
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL, { explicit: true }).allowed, false)
  assert.equal(
    policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL, { explicit: true, scope: DATA_CLASSES.CONFIDENTIAL, by: 'operator' }).allowed,
    true,
  )
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.RESTRICTED, { explicit: true, scope: DATA_CLASSES.CONFIDENTIAL }).allowed, false)
})

test('secrets are redacted and only their category is reported', () => {
  const input = 'key is sk-abcdefghij1234567890 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'
  const result = redactSecrets(input)
  assert.equal(result.text.includes('sk-abcdefghij1234567890'), false)
  assert.equal(result.text.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'), false)
  assert.match(result.text, /\[REDACTED:openai_style_key\]/)

  // A specific pattern must be tried before a general one that also matches it.
  // `sk-ant-...` satisfies both, so with the OpenAI pattern first the Anthropic
  // pattern was unreachable and every Anthropic key was reported under the wrong
  // name. The credential was still redacted, so nothing failed -- which is exactly
  // why the name needs pinning rather than the redaction.
  assert.deepEqual(redactSecrets('key sk-ant-api03-abcdefghijklmnopqrstuvwx').findings, ['anthropic_style_key'])
  assert.deepEqual(redactSecrets('key sk-proj-abcdefghijklmnopqrstuvwxyz0123').findings, ['openai_style_key'])
  assert.ok(result.findings.includes('github_token'))
  // The findings list must never contain the secret itself.
  assert.equal(JSON.stringify(result.findings).includes('abcdefghij'), false)
})

test('private key blocks and connection strings are redacted', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
  assert.match(redactSecrets(pem).text, /\[REDACTED:private_key_block\]/)
  const conn = 'postgres://user:supersecretpw@db.internal:5432/app'
  const result = redactSecrets(conn)
  assert.equal(result.text.includes('supersecretpw'), false)
})

test('redactDeep walks nested structures', () => {
  const payload = {
    messages: [{ role: 'user', content: 'my password is hunter2hunter2' }],
    meta: { nested: { token: 'sk-abcdefghij1234567890' } },
    count: 3,
  }
  const { value, findings } = redactDeep(payload)
  assert.equal(value.count, 3)
  assert.equal(value.messages[0].role, 'user')
  assert.match(value.meta.nested.token, /REDACTED/)
  assert.ok(findings.length > 0)
  assert.equal(JSON.stringify(value).includes('sk-abcdefghij'), false)
})

test('classification: credential material is RESTRICTED, secrets are CONFIDENTIAL', () => {
  assert.equal(classifyText('AKIAIOSFODNN7EXAMPLE here').dataClass, DATA_CLASSES.RESTRICTED)
  assert.equal(classifyText('token sk-abcdefghij1234567890').dataClass, DATA_CLASSES.CONFIDENTIAL)
  assert.equal(classifyText('This document is CONFIDENTIAL — do not distribute').dataClass, DATA_CLASSES.CONFIDENTIAL)
  assert.equal(classifyText('The weather is pleasant today.').dataClass, DATA_CLASSES.PUBLIC)
})

test('classification: environment-variable style credentials are RESTRICTED', () => {
  // Regression: a word boundary cannot be used for these, because in
  // AWS_SECRET_ACCESS_KEY the '_' is a word character and \bsecret\b never
  // matches. Pasted CI logs and .env dumps are full of this shape.
  const cases = [
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY',
    'DATABASE_PASSWORD=hunter2hunter2',
    'export GITHUB_TOKEN: ghp_abcdefabcdefabcdef',
    'MY_API_KEY="abcdef0123456789"',
    'SERVICE_PRIVATE_KEY=MIIEvQIBADANBgkqhki',
  ]
  for (const text of cases) {
    const result = classifyText(text)
    assert.equal(result.dataClass, DATA_CLASSES.RESTRICTED, `${text} classified as ${result.dataClass}`)
    assert.match(result.reason, /credential material/)
  }

  // The value is redacted, and the audit signal names the kind, not the secret.
  const redacted = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY')
  assert.equal(redacted.text.includes('wJalrXUtnFEMI'), false)
  assert.deepEqual(redacted.findings, ['env_style_secret'])
})

test('classification: credentials in URLs and provider keys are caught', () => {
  assert.equal(classifyText('fetch https://svc:sup3rsecret@internal.example/api').dataClass, DATA_CLASSES.RESTRICTED)
  assert.equal(classifyText('AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCD==').dataClass, DATA_CLASSES.RESTRICTED)
  assert.equal(classifyText('npm_abcdefghijklmnopqrstuvwxyz012345').dataClass, DATA_CLASSES.CONFIDENTIAL)

  const url = redactSecrets('see https://svc:sup3rsecret@internal.example/api')
  assert.equal(url.text.includes('sup3rsecret'), false)
})

test('classification: secret-shaped words in prose are not false positives', () => {
  // Mentioning a secret is not the same as carrying one: no assignment, no value.
  assert.equal(classifyText('the secret word appears in prose but is not a credential').dataClass, DATA_CLASSES.PUBLIC)
  assert.equal(classifyText('rotate the API key before the release').dataClass, DATA_CLASSES.PUBLIC)
  assert.equal(classifyText('AWS_SECRET_ACCESS_KEY is the name of an environment variable').dataClass, DATA_CLASSES.PUBLIC)
  assert.equal(redactSecrets('a short token=x').findings.length, 0, 'values below the length floor are left alone')
})

test('classification: source code defaults to INTERNAL', () => {
  const code = `import { readFileSync } from 'node:fs'\nexport function load(path) {\n  return readFileSync(path, 'utf8')\n}\n`
  assert.equal(looksLikeSourceCode(code), true)
  assert.equal(classifyText(code).dataClass, DATA_CLASSES.INTERNAL)
})

test('classification: an explicit declaration always wins', () => {
  assert.equal(classifyText('AKIAIOSFODNN7EXAMPLE', DATA_CLASSES.PUBLIC).dataClass, DATA_CLASSES.PUBLIC)
  assert.throws(() => classifyText('x', 'nonsense'), TypeError)
})
