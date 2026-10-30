import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import type { OverlaySettings } from '@shared/types'

const preload = join(__dirname, '../preload/index.js')

function load(win: BrowserWindow, page: 'index' | 'overlay' | 'picker', hash = ''): void {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) void win.loadURL(`${dev}/${page}.html${hash}`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`), { hash: hash.replace(/^#/, '') })
}

const webPreferences = {
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false
}

export function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Copilot',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    // Audio capture lives in this renderer, so it must keep running while hidden.
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  })
  load(win, 'index')
  win.once('ready-to-show', () => win.show())
  return win
}

/** WDA_EXCLUDEFROMCAPTURE exists since Windows 10 2004 (build 19041); on macOS the flag is NSWindowSharingNone, which ScreenCaptureKit ignores. */
export function displayProtectionSupported(): boolean {
  if (process.platform === 'darwin') return true
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= 19041
}

export function defaultOverlayBounds(): Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  const width = 460
  const height = 220
  return { x: wa.x + wa.width - width - 24, y: wa.y + 24, width, height }
}

export function sanitizeBounds(b: OverlaySettings['bounds']): Rectangle {
  if (!b) return defaultOverlayBounds()
  const visible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return b.x + 60 > wa.x && b.x < wa.x + wa.width - 60 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 40
  })
  return visible ? b : defaultOverlayBounds()
}

export function createOverlay(o: OverlaySettings): BrowserWindow {
  const bounds = sanitizeBounds(o.bounds)
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 150,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: o.pinned,
    // Never takes keyboard focus: typing in the IDE or meeting app keeps going there.
    focusable: false,
    // The window never becomes key, so on macOS a click would otherwise be swallowed instead of reaching the buttons.
    acceptFirstMouse: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Copilot — подсказки',
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  })
  if (o.pinned) win.setAlwaysOnTop(true, 'screen-saver')
  // macOS keeps full-screen apps (Zoom, Meet) in their own Space; without this the hints stay behind on the desktop.
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  load(win, 'overlay')
  return win
}

export function createPicker(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#000000',
    webPreferences
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setContentProtection(true)
  load(win, 'picker')
  return win
}
