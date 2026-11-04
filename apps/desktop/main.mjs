import { app, BrowserWindow, dialog, utilityProcess } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalWebServer, listenLoopback } from './local-server.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
let coreProcess = null
let apiServer = null
let apiPort = null
let corePort = null
let coreRunning = false
let coreExitCode = null
let shuttingDown = false
app.setName('Ragam')

function paths() {
  if (app.isPackaged) {
    return {
      webRoot: join(process.resourcesPath, 'web'),
      coreEntry: join(process.resourcesPath, 'core', 'src', 'server.mjs'),
    }
  }
  return {
    webRoot: resolve(HERE, '../web/dist'),
    coreEntry: resolve(HERE, '../../services/core/src/server.mjs'),
  }
}

async function waitForCore(port) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (!coreRunning) throw new Error(`Core exited during startup${coreExitCode === null ? '' : ` (code ${coreExitCode})`}.`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) return
      lastError = new Error(`Core health check returned HTTP ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Core did not become ready within 30 seconds${lastError ? `: ${lastError.message}` : '.'}`)
}

async function startCore(coreEntry) {
  if (coreRunning) return corePort
  const dataDir = join(app.getPath('userData'), 'online')
  coreExitCode = null
  coreProcess = utilityProcess.fork(coreEntry, [], {
    serviceName: 'Ragam Core',
    stdio: 'pipe',
    env: {
      ...process.env,
      AETHERIS_CORE_HOST: '127.0.0.1',
      AETHERIS_CORE_PORT: '0',
      AETHERIS_LOCAL_SINGLE_USER: 'true',
      AETHERIS_ONLINE_DATA_DIR: dataDir,
      AETHERIS_COOKIE_SECURE: 'false',
    },
  })
  coreRunning = true

  let pendingOutput = ''
  let resolvePort, rejectPort
  const portReady = new Promise((resolve, reject) => { resolvePort = resolve; rejectPort = reject })
  const timeout = setTimeout(() => rejectPort(new Error('Core did not announce its local port within 30 seconds.')), 30_000)
  timeout.unref()
  coreProcess.stdout?.on('data', (chunk) => {
    pendingOutput += String(chunk)
    const lines = pendingOutput.split(/\r?\n/)
    pendingOutput = lines.pop() ?? ''
    for (const line of lines) {
      console.info(`[Ragam Core] ${line}`)
      try {
        const record = JSON.parse(line)
        if (record.event === 'core_started' && Number.isInteger(record.port) && record.port > 0) resolvePort(record.port)
      } catch { /* Human-readable Core startup lines are intentionally not JSON. */ }
    }
  })
  coreProcess.stderr?.on('data', (chunk) => console.error(`[Ragam Core] ${String(chunk).trimEnd()}`))
  coreProcess.once('exit', (code) => {
    coreRunning = false
    coreExitCode = code
    rejectPort(new Error(`Core exited during startup${code === null ? '' : ` (code ${code})`}.`))
  })
  try {
    corePort = await portReady
    await waitForCore(corePort)
    return corePort
  } finally {
    clearTimeout(timeout)
  }
}

async function ensureLocalServices() {
  if (apiServer && apiPort && coreRunning) return
  if (apiServer) {
    await new Promise((done) => apiServer.close(() => done()))
    apiServer = null
    apiPort = null
  }
  if (!coreRunning) coreProcess = null
  const { coreEntry, webRoot } = paths()
  corePort = await startCore(coreEntry)
  apiServer = createLocalWebServer(webRoot, corePort)
  apiPort = await listenLoopback(apiServer)
}

async function openDesktopWindow() {
  await ensureLocalServices()
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#08060c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const localOrigin = `http://127.0.0.1:${apiPort}`
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    try { if (new URL(target).origin !== localOrigin) event.preventDefault() } catch { event.preventDefault() }
  })
  window.once('ready-to-show', () => window.show())
  await window.loadURL(localOrigin)
  return window
}

function stopCore() {
  if (!coreProcess || !coreRunning) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(() => {
      if (coreRunning) coreProcess.kill()
      done()
    }, 5_000)
    timer.unref()
    coreProcess.once('exit', () => { clearTimeout(timer); done() })
    coreProcess.kill()
  })
}

app.whenReady().then(async () => {
  try {
    const window = await openDesktopWindow()
    if (process.env.RAGAM_DESKTOP_SMOKE === '1') {
      const [health, auth] = await Promise.all([
        fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(5_000) }),
        fetch(`http://127.0.0.1:${apiPort}/api/auth`, { signal: AbortSignal.timeout(5_000) }),
      ])
      if (!health.ok || !auth.ok || (await auth.json()).mode !== 'local') {
        throw new Error(`Desktop smoke check failed (health=${health.status}, auth=${auth.status}).`)
      }
      console.info('RAGAM_DESKTOP_SMOKE_OK')
      window.close()
      app.quit()
      return
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openDesktopWindow().catch((error) => dialog.showErrorBox('Ragam could not start', error.message))
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (process.env.RAGAM_DESKTOP_SMOKE === '1') {
      console.error(`RAGAM_DESKTOP_SMOKE_FAILED: ${message}`)
      process.exitCode = 1
    } else dialog.showErrorBox('Ragam could not start', message)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shuttingDown || (!coreProcess && !apiServer)) return
  event.preventDefault()
  shuttingDown = true
  const closeWeb = apiServer ? new Promise((done) => apiServer.close(() => done())) : Promise.resolve()
  Promise.all([closeWeb, stopCore()]).finally(() => app.quit())
})
