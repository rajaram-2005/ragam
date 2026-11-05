import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const release = resolve('release')
if (!existsSync(release)) throw new Error('No unpacked desktop app found; run electron-builder --dir first.')
const names = readdirSync(release)
let executable

if (process.platform === 'win32') {
  for (const name of names.filter((entry) => entry.endsWith('-unpacked'))) {
    const candidate = join(release, name, 'Ragam.exe')
    if (existsSync(candidate)) { executable = candidate; break }
  }
} else if (process.platform === 'darwin') {
  for (const name of names.filter((entry) => entry.startsWith('mac'))) {
    const candidate = join(release, name, 'Ragam.app', 'Contents', 'MacOS', 'Ragam')
    if (existsSync(candidate)) { executable = candidate; break }
  }
} else {
  for (const name of names.filter((entry) => entry.endsWith('-unpacked'))) {
    const candidate = join(release, name, 'ragam')
    if (existsSync(candidate)) { executable = candidate; break }
  }
}
assert.ok(executable, `No unpacked Ragam executable found for ${process.platform}/${process.arch} in ${release}`)

const command = process.platform === 'linux' && process.env.CI === 'true' ? 'xvfb-run' : executable
const args = command === 'xvfb-run' ? ['-a', executable] : []
const child = spawnSync(command, args, {
  cwd: process.cwd(),
  env: { ...process.env, RAGAM_DESKTOP_SMOKE: '1' },
  encoding: 'utf8',
  timeout: 120_000,
  windowsHide: true,
})
const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
process.stdout.write(output)
if (child.error) throw child.error
if (child.status !== 0) {
  // Keep the actionable child failure in the check annotation as well as the job log.
  // This makes cross-platform smoke failures diagnosable when hosted log archives are unavailable.
  const detail = output.split(/\r?\n/).filter(Boolean).slice(-12).join(' | ').slice(0, 2500)
    .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  process.stderr.write(`::error title=Packaged desktop smoke details::${detail}\n`)
}
assert.equal(child.status, 0, `packaged Ragam exited with ${child.status ?? child.signal}`)
assert.match(output, /RAGAM_DESKTOP_SMOKE_OK/, 'packaged UI must start Core and pass the same-origin health/auth checks')
