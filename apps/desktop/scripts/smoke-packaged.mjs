import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

function fail(message) {
  const escaped = message.slice(0, 2500)
    .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  process.stdout.write(`::error title=Packaged desktop smoke details::${escaped}\n`)
  throw new Error(message)
}

const release = resolve('release')
if (!existsSync(release)) fail('No unpacked desktop app found; run electron-builder --dir first.')
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
  const appPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const binaryNames = [appPackage.build?.executableName, appPackage.name, appPackage.build?.productName]
    .filter(Boolean).map((name) => name.toLocaleLowerCase())
  for (const name of names.filter((entry) => entry.endsWith('-unpacked'))) {
    const unpacked = join(release, name)
    const binary = readdirSync(unpacked).find((entry) => binaryNames.includes(entry.toLocaleLowerCase()))
    if (binary) { executable = join(unpacked, binary); break }
  }
}
if (!executable) {
  const contents = names.filter((name) => name.endsWith('-unpacked'))
    .map((name) => `${name}=[${readdirSync(join(release, name)).join(', ')}]`).join('; ')
  fail(`No unpacked Ragam executable found for ${process.platform}/${process.arch} in ${release}; entries: ${names.join(', ')}; unpacked contents: ${contents}`)
}

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
const smokePassed = /RAGAM_DESKTOP_SMOKE_OK/.test(output)
if (child.error || child.status !== 0 || !smokePassed) {
  const detail = [
    `command=${command} ${args.join(' ')}`,
    `status=${child.status ?? 'null'}`,
    `signal=${child.signal ?? 'none'}`,
    child.error?.stack ?? child.error?.message,
    ...output.split(/\r?\n/).filter(Boolean).slice(-12),
  ].filter(Boolean).join(' | ')
  fail(detail)
}
