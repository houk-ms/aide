import { createRequire } from 'module'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

// Use Node's createRequire to bypass vite's bundler
// nut.js has native bindings that don't work with vite's commonjs plugin
const require = createRequire(import.meta.url)

// ============================================================
// Desktop Automation Module — nut.js-based desktop control
// ============================================================

// Type definitions for nut.js (runtime-loaded native module)
interface WindowHandle {
  title: Promise<string>
  region: Promise<{ left: number; top: number; width: number; height: number }>
  focus: () => Promise<void>
}

interface NutJsModule {
  mouse: {
    config: { autoDelayMs: number }
    move: (points: Array<{ x: number; y: number }>) => Promise<void>
    click: (button: unknown) => Promise<void>
    doubleClick: (button: unknown) => Promise<void>
    pressButton: (button: unknown) => Promise<void>
    releaseButton: (button: unknown) => Promise<void>
    scrollDown: (amount: number) => Promise<void>
    getPosition: () => Promise<{ x: number; y: number }>
  }
  keyboard: {
    config: { autoDelayMs: number }
    type: (text: string) => Promise<void>
    pressKey: (key: unknown) => Promise<void>
    releaseKey: (key: unknown) => Promise<void>
  }
  screen: {
    grab: () => Promise<{ data: Buffer; width: number; height: number }>
    grabRegion: (region: { left: number; top: number; width: number; height: number }) => Promise<{ data: Buffer; width: number; height: number }>
    width: () => Promise<number>
    height: () => Promise<number>
  }
  Point: new (x: number, y: number) => { x: number; y: number }
  Button: { LEFT: unknown; RIGHT: unknown }
  Key: Record<string, unknown>
  getWindows: () => Promise<WindowHandle[]>
  getActiveWindow: () => Promise<WindowHandle>
}

// Lazy-load nut.js to handle native binding failures gracefully
let nutjs: NutJsModule | null = null
let loadError: Error | null = null

function getNutJs(): NutJsModule {
  if (loadError) {
    throw loadError
  }
  if (!nutjs) {
    try {
      nutjs = require('@nut-tree-fork/nut-js') as NutJsModule
      // Configure nut.js defaults
      nutjs.mouse.config.autoDelayMs = 100
      nutjs.keyboard.config.autoDelayMs = 50
    } catch (err) {
      loadError = err as Error
      console.error('[Desktop] Failed to load nut.js:', err)
      throw err
    }
  }
  return nutjs
}

/**
 * Check if desktop automation is available
 */
export function isDesktopAvailable(): boolean {
  try {
    getNutJs()
    // In headless CI environments, this would fail
    return process.env.DISPLAY !== undefined || process.platform === 'win32' || process.platform === 'darwin'
  } catch {
    return false
  }
}

/**
 * Get a helpful error message explaining why desktop automation isn't available
 * and how to fix it on the current platform.
 */
export function getDesktopUnavailableReason(): string {
  const isPackaged = app.isPackaged

  // First check if nut.js loaded
  try {
    getNutJs()
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    
    // Common error patterns and their fixes
    if (errorMsg.includes('Could not find') || errorMsg.includes('native') || errorMsg.includes('.node')) {
      if (isPackaged) {
        return `Desktop automation failed to initialize. This may be caused by antivirus software blocking the native module, or a corrupted installation. Try reinstalling Aide, or check if your antivirus is blocking the app.`
      }
      return `Desktop automation native bindings not found. Run 'npm install' to rebuild native modules for Electron.`
    }
    
    if (isPackaged) {
      return `Desktop automation failed to load: ${errorMsg}. Try reinstalling Aide or running it as administrator.`
    }
    return `Desktop automation failed to load: ${errorMsg}. Try running 'npm install' to rebuild native modules.`
  }

  // nut.js loaded but environment issues
  switch (process.platform) {
    case 'darwin':
      return `Desktop automation requires accessibility permissions on macOS. Go to System Settings → Privacy & Security → Accessibility, then enable Aide.`
    case 'linux':
      if (!process.env.DISPLAY) {
        return `Desktop automation requires a display server on Linux. Set the DISPLAY environment variable (e.g., DISPLAY=:0). Also ensure xdotool is installed: sudo apt install xdotool`
      }
      return `Desktop automation requires xdotool on Linux. Install it with: sudo apt install xdotool`
    case 'win32':
      if (isPackaged) {
        return `Desktop automation failed on Windows. Try running Aide as administrator, or check if antivirus software is blocking it. If the issue persists, try reinstalling Aide.`
      }
      return `Desktop automation failed on Windows. Ensure you ran 'npm install' to build native modules. If running as admin doesn't help, try reinstalling @nut-tree-fork/nut-js.`
    default:
      return `Desktop automation is not supported on ${process.platform}.`
  }
}

/**
 * Move mouse to absolute screen coordinates
 */
export async function moveMouse(x: number, y: number): Promise<void> {
  const { mouse, Point } = getNutJs()
  await mouse.move([new Point(x, y)])
}

/**
 * Click at current mouse position or specified coordinates
 */
export async function click(x?: number, y?: number, button: 'left' | 'right' = 'left'): Promise<void> {
  const { mouse, Button, Point } = getNutJs()
  if (x !== undefined && y !== undefined) {
    await mouse.move([new Point(x, y)])
  }
  const btn = button === 'right' ? Button.RIGHT : Button.LEFT
  await mouse.click(btn)
}

/**
 * Double-click at current position or specified coordinates
 */
export async function doubleClick(x?: number, y?: number): Promise<void> {
  const { mouse, Button, Point } = getNutJs()
  if (x !== undefined && y !== undefined) {
    await mouse.move([new Point(x, y)])
  }
  await mouse.doubleClick(Button.LEFT)
}

/**
 * Right-click at current position or specified coordinates
 */
export async function rightClick(x?: number, y?: number): Promise<void> {
  await click(x, y, 'right')
}

/**
 * Drag from one point to another
 */
export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  const { mouse, Button, Point } = getNutJs()
  await mouse.move([new Point(fromX, fromY)])
  await mouse.pressButton(Button.LEFT)
  await mouse.move([new Point(toX, toY)])
  await mouse.releaseButton(Button.LEFT)
}

/**
 * Scroll the mouse wheel
 */
export async function scroll(amount: number, direction: 'up' | 'down' = 'down'): Promise<void> {
  const { mouse } = getNutJs()
  const scrollAmount = direction === 'up' ? -amount : amount
  await mouse.scrollDown(scrollAmount)
}

/**
 * Type text using keyboard
 */
export async function typeText(text: string): Promise<void> {
  const { keyboard } = getNutJs()
  await keyboard.type(text)
}

/**
 * Press a single key
 */
export async function pressKey(key: string): Promise<void> {
  const { keyboard, Key } = getNutJs()
  const keyMap: Record<string, typeof Key[keyof typeof Key]> = {
    'enter': Key.Enter,
    'return': Key.Enter,
    'tab': Key.Tab,
    'escape': Key.Escape,
    'esc': Key.Escape,
    'backspace': Key.Backspace,
    'delete': Key.Delete,
    'space': Key.Space,
    'up': Key.Up,
    'down': Key.Down,
    'left': Key.Left,
    'right': Key.Right,
    'home': Key.Home,
    'end': Key.End,
    'pageup': Key.PageUp,
    'pagedown': Key.PageDown,
    'f1': Key.F1,
    'f2': Key.F2,
    'f3': Key.F3,
    'f4': Key.F4,
    'f5': Key.F5,
    'f6': Key.F6,
    'f7': Key.F7,
    'f8': Key.F8,
    'f9': Key.F9,
    'f10': Key.F10,
    'f11': Key.F11,
    'f12': Key.F12
  }

  const k = keyMap[key.toLowerCase()]
  if (k) {
    await keyboard.pressKey(k)
    await keyboard.releaseKey(k)
  } else {
    // Single character
    await keyboard.type(key)
  }
}

/**
 * Press a keyboard shortcut (e.g., Ctrl+C, Cmd+V)
 */
export async function pressShortcut(shortcut: string): Promise<void> {
  const { keyboard, Key } = getNutJs()
  type KeyType = typeof Key[keyof typeof Key]
  const parts = shortcut.toLowerCase().split('+').map(p => p.trim())
  const modifiers: KeyType[] = []
  let mainKey: KeyType | null = null

  const modifierMap: Record<string, KeyType> = {
    'ctrl': Key.LeftControl,
    'control': Key.LeftControl,
    'alt': Key.LeftAlt,
    'shift': Key.LeftShift,
    'cmd': Key.LeftSuper,
    'command': Key.LeftSuper,
    'meta': Key.LeftSuper,
    'win': Key.LeftSuper
  }

  const keyMap: Record<string, KeyType> = {
    'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E,
    'f': Key.F, 'g': Key.G, 'h': Key.H, 'i': Key.I, 'j': Key.J,
    'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N, 'o': Key.O,
    'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T,
    'u': Key.U, 'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y,
    'z': Key.Z,
    '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3,
    '4': Key.Num4, '5': Key.Num5, '6': Key.Num6, '7': Key.Num7,
    '8': Key.Num8, '9': Key.Num9,
    'enter': Key.Enter, 'tab': Key.Tab, 'escape': Key.Escape,
    'space': Key.Space, 'backspace': Key.Backspace, 'delete': Key.Delete,
    'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
    'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
    'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12
  }

  for (const part of parts) {
    if (modifierMap[part]) {
      modifiers.push(modifierMap[part])
    } else if (keyMap[part]) {
      mainKey = keyMap[part]
    }
  }

  if (!mainKey) {
    throw new Error(`Unknown key in shortcut: ${shortcut}`)
  }

  // Press modifiers
  for (const mod of modifiers) {
    await keyboard.pressKey(mod)
  }

  try {
    // Press main key
    await keyboard.pressKey(mainKey)
    await keyboard.releaseKey(mainKey)
  } finally {
    // Release modifiers in reverse order (always, even on error)
    for (const mod of modifiers.reverse()) {
      await keyboard.releaseKey(mod)
    }
  }
}

/**
 * Take a screenshot of the entire screen and save as PNG file.
 * Returns the file path to the saved screenshot.
 */
export async function takeScreenshot(): Promise<string> {
  const { screen } = getNutJs()
  const image = await screen.grab()
  const { data, width, height } = image

  // Ensure screenshots directory exists
  const screenshotsDir = path.join(app.getPath('userData'), 'screenshots')
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true })
  }

  // Generate unique filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(screenshotsDir, `screenshot-${timestamp}.png`)

  // Encode BGRA to PNG (nut.js returns BGRA on Windows)
  const pngBuffer = encodeRawBgraToPng(data, width, height)
  fs.writeFileSync(filePath, pngBuffer)

  return filePath
}

/**
 * Encode raw BGRA buffer to PNG format.
 * nut.js returns BGRA on Windows, so we convert to RGBA for PNG.
 */
function encodeRawBgraToPng(bgra: Buffer, width: number, height: number): Buffer {
  const { deflateSync } = require('zlib') as typeof import('zlib')

  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  // IHDR chunk
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData.writeUInt8(8, 8)   // bit depth
  ihdrData.writeUInt8(6, 9)   // color type (RGBA)
  ihdrData.writeUInt8(0, 10)  // compression
  ihdrData.writeUInt8(0, 11)  // filter
  ihdrData.writeUInt8(0, 12)  // interlace
  const ihdr = createPngChunk('IHDR', ihdrData)

  // IDAT chunk - add filter byte (0) at start of each row, then deflate
  // Also convert BGRA → RGBA by swapping B and R channels
  const rowSize = width * 4
  const filteredData = Buffer.alloc(height * (1 + rowSize))
  for (let y = 0; y < height; y++) {
    filteredData[y * (1 + rowSize)] = 0 // no filter
    const rowStart = y * rowSize
    const destRowStart = y * (1 + rowSize) + 1
    for (let x = 0; x < width; x++) {
      const srcOffset = rowStart + x * 4
      const destOffset = destRowStart + x * 4
      // BGRA → RGBA: swap B and R
      filteredData[destOffset] = bgra[srcOffset + 2]     // R ← B
      filteredData[destOffset + 1] = bgra[srcOffset + 1] // G ← G
      filteredData[destOffset + 2] = bgra[srcOffset]     // B ← R
      filteredData[destOffset + 3] = bgra[srcOffset + 3] // A ← A
    }
  }
  const compressed = deflateSync(filteredData)
  const idat = createPngChunk('IDAT', compressed)

  // IEND chunk
  const iend = createPngChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const { crc32 } = require('buffer') as { crc32: (data: Buffer | string, encoding?: string) => number }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crcData = Buffer.concat([typeBuffer, data])
  const crcValue = Buffer.alloc(4)
  // Use zlib crc32 instead
  const zlib = require('zlib') as typeof import('zlib')
  // Node's zlib doesn't expose crc32 directly, compute manually
  let crc = crc32Compute(crcData)
  crcValue.writeUInt32BE(crc >>> 0, 0)
  return Buffer.concat([length, typeBuffer, data, crcValue])
}

function crc32Compute(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return ~crc
}

/**
 * Get screen dimensions
 */
export async function getScreenSize(): Promise<{ width: number; height: number }> {
  const { screen } = getNutJs()
  const width = await screen.width()
  const height = await screen.height()
  return { width, height }
}

/**
 * Get current mouse position
 */
export async function getMousePosition(): Promise<{ x: number; y: number }> {
  const { mouse } = getNutJs()
  const pos = await mouse.getPosition()
  return { x: pos.x, y: pos.y }
}

/**
 * Wait for a specified duration (in milliseconds)
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================
// Window Management — list, focus, and interact with windows
// ============================================================

export interface WindowInfo {
  title: string
  bounds: { left: number; top: number; width: number; height: number }
}

/**
 * List all open windows with their titles and bounds
 */
export async function listWindows(): Promise<WindowInfo[]> {
  const nutjs = getNutJs()
  const handles = await nutjs.getWindows()
  const windows: WindowInfo[] = []
  
  for (const handle of handles) {
    try {
      const title = await handle.title
      const region = await handle.region
      // Skip windows with empty titles or zero size (system/hidden windows)
      if (title && region.width > 0 && region.height > 0) {
        windows.push({
          title,
          bounds: {
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height
          }
        })
      }
    } catch {
      // Skip windows we can't access
    }
  }
  
  return windows
}

/**
 * Get the currently active/focused window
 */
export async function getActiveWindow(): Promise<WindowInfo | null> {
  const nutjs = getNutJs()
  try {
    const handle = await nutjs.getActiveWindow()
    const title = await handle.title
    const region = await handle.region
    return {
      title,
      bounds: {
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height
      }
    }
  } catch {
    return null
  }
}

/**
 * Focus a window by title (partial match, case-insensitive)
 */
export async function focusWindow(titleQuery: string): Promise<boolean> {
  const nutjs = getNutJs()
  const handles = await nutjs.getWindows()
  const query = titleQuery.toLowerCase()
  
  for (const handle of handles) {
    try {
      const title = await handle.title
      if (title && title.toLowerCase().includes(query)) {
        await handle.focus()
        // Small delay to let the window come to front
        await wait(100)
        return true
      }
    } catch {
      // Continue searching
    }
  }
  
  return false
}

/**
 * Get bounds of a window by title (partial match, case-insensitive)
 */
export async function getWindowBounds(titleQuery: string): Promise<WindowInfo | null> {
  const nutjs = getNutJs()
  const handles = await nutjs.getWindows()
  const query = titleQuery.toLowerCase()
  
  for (const handle of handles) {
    try {
      const title = await handle.title
      if (title && title.toLowerCase().includes(query)) {
        const region = await handle.region
        return {
          title,
          bounds: {
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height
          }
        }
      }
    } catch {
      // Continue searching
    }
  }
  
  return null
}

/**
 * Take a screenshot of a specific window by title
 */
export async function takeWindowScreenshot(titleQuery: string): Promise<{ filePath: string; bounds: WindowInfo['bounds'] } | null> {
  const nutjs = getNutJs()
  const windowInfo = await getWindowBounds(titleQuery)
  
  if (!windowInfo) {
    return null
  }
  
  // Focus the window first so it's visible
  await focusWindow(titleQuery)
  await wait(200) // Wait for window to be fully visible
  
  // Grab just the window region
  const image = await nutjs.screen.grabRegion({
    left: windowInfo.bounds.left,
    top: windowInfo.bounds.top,
    width: windowInfo.bounds.width,
    height: windowInfo.bounds.height
  })
  
  // Ensure screenshots directory exists
  const screenshotsDir = path.join(app.getPath('userData'), 'screenshots')
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true })
  }
  
  // Generate unique filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeTitle = windowInfo.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
  const filePath = path.join(screenshotsDir, `window-${safeTitle}-${timestamp}.png`)
  
  // Encode BGRA to PNG
  const pngBuffer = encodeRawBgraToPng(image.data, image.width, image.height)
  fs.writeFileSync(filePath, pngBuffer)
  
  return { filePath, bounds: windowInfo.bounds }
}
