#!/usr/bin/env node
// Verify that this repository can be released.
//
//   node services/core/scripts/release-check.mjs --core 798 --web 92 --fabric 814
//   node services/core/scripts/release-check.mjs --core 798 --web 92 --fabric 814 --manifest
//
// The suite totals are passed in rather than guessed: the point of the check is to compare the
// numbers the documentation states with the numbers the suites produced. A tool that read its own
// expectations out of the same document would verify nothing.
//
// Exit code 0 means every stated number is reproducible from the supplied measurements.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectReleaseState, buildReleaseManifest, verifyRelease, RELEASE_ARTEFACTS } from '../src/release/manifest.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? null : args[index + 1]
}

const measured = {
  core: Number(flag('core')),
  web: Number(flag('web')),
  fabric: Number(flag('fabric')),
}

if (![measured.core, measured.web, measured.fabric].every((value) => Number.isInteger(value) && value > 0)) {
  console.error('usage: release-check.mjs --core <n> --web <n> --fabric <n> [--manifest]')
  console.error('the suite totals must be supplied: reading them from the documents being checked would verify nothing')
  process.exit(2)
}

const state = collectReleaseState(REPO, { measured })
const verdict = verifyRelease(state)

for (const problem of verdict.problems) console.error(`  ✗ ${problem}`)

if (!verdict.ok) {
  console.error(`\nrelease refused: ${verdict.problems.length} problem${verdict.problems.length === 1 ? '' : 's'}`)
  process.exit(1)
}

console.log(`release ${state.version} verified against ${measured.core} + ${measured.web} + ${measured.fabric} = ${measured.core + measured.web + measured.fabric} tests`)
console.log(`  changelog entry: ${verdict.facts.changelog.heading}`)
console.log(`  artefacts checked: ${verdict.facts.artefacts}`)
console.log(`  packs verified: ${verdict.facts.packs}`)

if (args.includes('--manifest')) {
  const manifest = buildReleaseManifest(state, { paths: RELEASE_ARTEFACTS.map((path) => resolve(REPO, path)), root: REPO })
  console.log(JSON.stringify(manifest, null, 2))
}
