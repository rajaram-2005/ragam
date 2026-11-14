#!/usr/bin/env node
// Build only the fixed electron-builder targets enumerated by the desktop CI matrix.
// The target crosses the GitHub Actions expression boundary as an environment
// variable (never interpolated into a shell script) and is allow-listed here.
import { spawnSync } from 'node:child_process'

const targets = new Map([
  ['--linux AppImage deb --x64 --arm64', ['--linux', 'AppImage', 'deb', '--x64', '--arm64']],
  ['--win nsis --x64 --arm64', ['--win', 'nsis', '--x64', '--arm64']],
  ['--mac dmg --x64', ['--mac', 'dmg', '--x64']],
  ['--mac dmg --arm64', ['--mac', 'dmg', '--arm64']],
])
const target = process.env.RAGAM_ELECTRON_BUILDER_TARGET
const args = targets.get(target)
if (!args) {
  console.error('Unsupported electron-builder target; refusing to execute an unreviewed argument list.')
  process.exit(2)
}

const windows = process.platform === 'win32'
const executable = windows ? (process.env.ComSpec || 'cmd.exe') : 'npx'
const commandArgs = windows
  ? ['/d', '/s', '/c', ['npx.cmd', 'electron-builder', ...args].join(' ')]
  : ['electron-builder', ...args]
// The Windows runner needs cmd.exe to invoke npm's .cmd shim. Every argument in
// this command line comes from the fixed allow-list above; matrix text is never
// concatenated into it.
const result = spawnSync(executable, commandArgs, {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  shell: false,
  env: process.env,
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) {
  console.error(`electron-builder could not start (${result.error.code ?? 'spawn error'}).`)
  process.exit(2)
}
if (result.status !== 0) {
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).slice(-25)
  const detail = lines.join(' ').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').slice(0, 2400)
  if (process.env.GITHUB_ACTIONS === 'true' && detail) {
    console.error(`::error title=Desktop installer build details::${detail}`)
  }
  process.exit(Number.isInteger(result.status) ? result.status : 1)
}
