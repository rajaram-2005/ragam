// The clean-install path for first-party weights: fetch the CI tarball,
// verify its SHA256SUMS, then verify the release pins — and refuse anything
// that fails either check without leaving a half-install behind.
//
// Fixtures are real ustar tarballs built in-process, so the extractor is
// exercised exactly as codeload output exercises it (prefix directory,
// split weights, sums file) with no network and no system `tar`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  classifyInstalled, extractTarGz, installKlyvaronModels, joinSplitWeights, parseSums, planInstall,
  WEIGHTS_SOURCES, WEIGHTS_TAG, WEIGHTS_TARBALL_FALLBACK_URL, WEIGHTS_TARBALL_URL,
} from '../scripts/install-klyvaron-models.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(body.length.toString(8).padStart(11, '0') + ' ', 124, 12)
  header.write('00000000000 ', 136, 12)
  header.write('        ', 148, 8)
  header.write(type, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded])
}

function tarGz(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-install-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('sums parsing accepts both sha256sum spellings and ignores noise', () => {
  const rows = parseSums([
    `${'a'.repeat(64)}  klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz`,
    `${'b'.repeat(64)} *klyvaron-pro-image/weights.npz`,
    '# a comment',
    '',
    'not a sums line',
  ].join('\n'))
  assert.deepEqual(rows, [
    { sha256: 'a'.repeat(64), file: 'klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz' },
    { sha256: 'b'.repeat(64), file: 'klyvaron-pro-image/weights.npz' },
  ])
})

test('extraction strips the codeload prefix and refuses traversal and links', (t) => {
  const dir = scratch(t)
  const good = tarGz([
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/', Buffer.alloc(0), '5'),
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/weights.bin', Buffer.from('weights-bytes')),
    tarEntry('ragam-deadbeef/SHA256SUMS', Buffer.from('sums')),
  ])
  const written = extractTarGz(good, join(dir, 'out'))
  assert.deepEqual(written.sort(), ['SHA256SUMS', 'klyvaron-pro-lm/weights.bin'])
  assert.equal(readFileSync(join(dir, 'out', 'klyvaron-pro-lm', 'weights.bin'), 'utf8'), 'weights-bytes')

  const traversal = tarGz([tarEntry('ragam-deadbeef/../../escape.txt', Buffer.from('x'))])
  assert.throws(() => extractTarGz(traversal, join(dir, 'out2')), /escapes the destination/)
  const link = tarGz([tarEntry('ragam-deadbeef/link', Buffer.alloc(0), '2')])
  assert.throws(() => extractTarGz(link, join(dir, 'out3')), /unsupported type/)
})

test('split weights are joined in order and the fragments removed', (t) => {
  const dir = scratch(t)
  const model = join(dir, 'klyvaron-max-lm')
  mkdirSync(model, { recursive: true })
  writeFileSync(join(model, 'klyvaron-max-lm-0.1.0.npz.partab'), Buffer.from('second-'))
  writeFileSync(join(model, 'klyvaron-max-lm-0.1.0.npz.partaa'), Buffer.from('first-'))
  const joined = joinSplitWeights(dir)
  assert.deepEqual(joined, ['klyvaron-max-lm/klyvaron-max-lm-0.1.0.npz'])
  assert.equal(readFileSync(join(model, 'klyvaron-max-lm-0.1.0.npz'), 'utf8'), 'first-second-')
  assert.equal(existsSync(join(model, 'klyvaron-max-lm-0.1.0.npz.partaa')), false)
})

test('slot classification distinguishes missing, local, and forged-release artifacts', (t) => {
  const dir = scratch(t)
  assert.equal(classifyInstalled(dir, 'klyvaron-pro-lm').state, 'missing')
  assert.ok(planInstall(dir).every((entry) => entry.state === 'missing'))

  const model = join(dir, 'klyvaron-pro-lm')
  mkdirSync(model, { recursive: true })
  writeFileSync(join(model, 'klyvaron-pro-lm.klyvaron.json'), JSON.stringify({ version: '0.1.0-local.ab12cd34' }))
  assert.equal(classifyInstalled(dir, 'klyvaron-pro-lm').state, 'local')

  writeFileSync(join(model, 'klyvaron-pro-lm.klyvaron.json'), JSON.stringify({ version: '0.1.0' }))
  writeFileSync(join(model, 'klyvaron-pro-lm-0.1.0.npz'), Buffer.from('not the release'))
  const forged = classifyInstalled(dir, 'klyvaron-pro-lm')
  assert.equal(forged.state, 'mismatch')
  assert.match(forged.problem, /released pin/)
})

test('a self-consistent tarball that is not the release is refused, leaving no install behind', async (t) => {
  const dir = scratch(t)
  // Forge a complete-looking tarball: real structure, hashes that agree
  // with themselves — but the weights are not the pinned release bytes.
  const weights = Buffer.from('forged weights')
  const entries = [
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/', Buffer.alloc(0), '5'),
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz', weights),
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/klyvaron-pro-lm.klyvaron.json', Buffer.from(JSON.stringify({ version: '0.1.0' }))),
  ]
  entries.push(tarEntry('ragam-deadbeef/SHA256SUMS', Buffer.from(`${sha256(weights)}  klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz\n`)))
  const tarball = join(dir, 'forged.tar.gz')
  writeFileSync(tarball, tarGz(entries))

  const dataDir = join(dir, 'data')
  await assert.rejects(
    installKlyvaronModels({ dataDir, source: tarball, log: () => {} }),
    /does not match its release pin/,
  )
  assert.equal(existsSync(join(dataDir, 'klyvaron', 'models', 'klyvaron-pro-lm')), false, 'nothing was installed')
  assert.equal(
    existsSync(join(dataDir, 'klyvaron', `.install-staging-${process.pid}`)),
    false,
    'staging was cleaned up',
  )
})

test('a tarball whose files disagree with its own sums is refused before pin checks', async (t) => {
  const dir = scratch(t)
  const entries = [
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz', Buffer.from('bytes')),
    tarEntry('ragam-deadbeef/SHA256SUMS', Buffer.from(`${'f'.repeat(64)}  klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz\n`)),
  ]
  const tarball = join(dir, 'bad-sums.tar.gz')
  writeFileSync(tarball, tarGz(entries))
  await assert.rejects(
    installKlyvaronModels({ dataDir: join(dir, 'data'), source: tarball, log: () => {} }),
    /failed its own SHA256SUMS/,
  )
})

test('the tag tarball is the primary source, the pinned commit the fallback, and a dead source falls through', async (t) => {
  // The weights commit was reachable only by raw SHA (garbage-collectable);
  // the tag makes it a durable ref. Order matters: tag first, commit second.
  assert.equal(WEIGHTS_SOURCES.length, 2)
  assert.equal(WEIGHTS_SOURCES[0], WEIGHTS_TARBALL_URL)
  assert.ok(WEIGHTS_TARBALL_URL.includes(`refs/tags/${WEIGHTS_TAG}`), 'primary source is the tag')
  assert.equal(WEIGHTS_SOURCES[1], WEIGHTS_TARBALL_FALLBACK_URL)
  assert.ok(WEIGHTS_TARBALL_FALLBACK_URL.includes('c9f6aa2f5e31ed462caae1f94395ba46ea808a40'), 'fallback is the pinned commit')

  // A dead first candidate must fall through to the next, and the bytes that
  // arrive are still verified: the refusal below is the second source's own
  // sums failure, not a fetch failure.
  const dir = scratch(t)
  const entries = [
    tarEntry('ragam-deadbeef/klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz', Buffer.from('bytes')),
    tarEntry('ragam-deadbeef/SHA256SUMS', Buffer.from(`${'f'.repeat(64)}  klyvaron-pro-lm/klyvaron-pro-lm-0.1.0.npz\n`)),
  ]
  const tarball = join(dir, 'second-source.tar.gz')
  writeFileSync(tarball, tarGz(entries))
  await assert.rejects(
    installKlyvaronModels({ dataDir: join(dir, 'data'), source: [join(dir, 'missing.tar.gz'), tarball], log: () => {} }),
    /failed its own SHA256SUMS/,
    'the second source was tried and its bytes verified',
  )
  // With every candidate dead, the error names them all rather than the last one.
  await assert.rejects(
    installKlyvaronModels({ dataDir: join(dir, 'data2'), source: [join(dir, 'a.tar.gz'), join(dir, 'b.tar.gz')], log: () => {} }),
    /could not fetch Klyvaron weights from any source/,
  )
})
