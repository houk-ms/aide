import { createRequire } from 'module'
import { app, screen as electronScreen, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Use Node's createRequire to bypass vite's bundler
// nut.js has native bindings that don't work with vite's commonjs plugin
const require = createRequire(import.meta.url)

// Grid configuration for coordinate overlay
const GRID_COLS = 8  // A, B, C, D, E, F, G, H columns
const GRID_ROWS = 8  // 1, 2, 3, 4, 5, 6, 7, 8 rows
const GRID_LINE_COLOR = { r: 255, g: 0, b: 0, a: 180 }  // Semi-transparent red
const MOUSE_DOT_COLOR = { r: 255, g: 0, b: 0, a: 255 }  // Solid red
const MOUSE_DOT_RADIUS = 8  // Radius of mouse position indicator

// Windows 10/11 extended frame (shadow) offset
// The window bounds from nut.js include the invisible DWM shadow
// We need to compensate for this when clicking
const WINDOWS_SHADOW_LEFT = 7
const WINDOWS_SHADOW_RIGHT = 7
const WINDOWS_SHADOW_BOTTOM = 7
const WINDOWS_SHADOW_TOP = 0  // Top is usually 0 (title bar is part of content)

// ============================================================
// Desktop Automation Module — nut.js-based desktop control
// ============================================================

// Maximum screenshot dimension to avoid overwhelming vision models
// Most models internally resize to ~1500-2000px, so we cap at 1600 to:
// 1. Reduce data transfer size
// 2. Ensure coordinates returned by the model are accurate (no hidden rescaling)
const MAX_SCREENSHOT_DIMENSION = 1600

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

// ============================================================
// Display/Monitor Information
// ============================================================

export interface DisplayInfo {
  id: number
  isPrimary: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  label: string
}

/**
 * Get information about all connected displays/monitors.
 */
export function getAllDisplays(): DisplayInfo[] {
  const displays = electronScreen.getAllDisplays()
  const primary = electronScreen.getPrimaryDisplay()
  
  return displays.map((d, i) => ({
    id: d.id,
    isPrimary: d.id === primary.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    label: d.id === primary.id ? `Monitor ${i + 1} (Primary)` : `Monitor ${i + 1}`
  }))
}

/**
 * Get the primary display bounds.
 */
export function getPrimaryDisplayBounds(): { x: number; y: number; width: number; height: number } {
  const primary = electronScreen.getPrimaryDisplay()
  return primary.bounds
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
 * Take a screenshot and return as PNG buffer.
 * @param monitor - 'primary' to capture only the primary monitor, 'all' for all monitors, or display ID
 * Returns { buffer, width, height, bounds } for sending to the agent.
 */
export async function takeScreenshotBuffer(
  monitor: 'primary' | 'all' | number = 'primary'
): Promise<{ buffer: Buffer; width: number; height: number; bounds: { x: number; y: number; width: number; height: number } }> {
  const nutjs = getNutJs()
  
  if (monitor === 'all') {
    // Capture all monitors (original behavior)
    const image = await nutjs.screen.grab()
    const { data, width, height } = image
    const pngBuffer = encodeRawBgraToPng(data, width, height)
    return { buffer: pngBuffer, width, height, bounds: { x: 0, y: 0, width, height } }
  }
  
  // Get the target display bounds
  let targetBounds: { x: number; y: number; width: number; height: number }
  
  if (monitor === 'primary') {
    targetBounds = getPrimaryDisplayBounds()
  } else {
    // Find display by ID
    const displays = electronScreen.getAllDisplays()
    const targetDisplay = displays.find(d => d.id === monitor)
    if (!targetDisplay) {
      throw new Error(`Display with ID ${monitor} not found. Available: ${displays.map(d => d.id).join(', ')}`)
    }
    targetBounds = targetDisplay.bounds
  }
  
  // Capture just the target region
  const image = await nutjs.screen.grabRegion({
    left: targetBounds.x,
    top: targetBounds.y,
    width: targetBounds.width,
    height: targetBounds.height
  })
  
  const { data, width, height } = image
  const pngBuffer = encodeRawBgraToPng(data, width, height)
  return { buffer: pngBuffer, width, height, bounds: targetBounds }
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
 * Resize a PNG buffer if it exceeds MAX_SCREENSHOT_DIMENSION.
 * Uses Electron's nativeImage for reliable resizing without external dependencies.
 * Returns { buffer, width, height, scale } where scale is the resize factor applied.
 * If no resize needed, scale = 1.0
 */
function resizePngIfNeeded(
  pngBuffer: Buffer,
  originalWidth: number,
  originalHeight: number
): { buffer: Buffer; width: number; height: number; scale: number } {
  const maxDim = Math.max(originalWidth, originalHeight)
  
  if (maxDim <= MAX_SCREENSHOT_DIMENSION) {
    // No resize needed
    return { buffer: pngBuffer, width: originalWidth, height: originalHeight, scale: 1.0 }
  }
  
  // Calculate scale to fit within MAX_SCREENSHOT_DIMENSION
  const scale = MAX_SCREENSHOT_DIMENSION / maxDim
  const newWidth = Math.round(originalWidth * scale)
  const newHeight = Math.round(originalHeight * scale)
  
  try {
    // Use Electron's built-in nativeImage for resizing
    const image = nativeImage.createFromBuffer(pngBuffer)
    const resized = image.resize({ width: newWidth, height: newHeight, quality: 'better' })
    const resizedBuffer = resized.toPNG()
    
    return { buffer: resizedBuffer, width: newWidth, height: newHeight, scale }
  } catch (err) {
    // If resize fails, return original
    console.warn('[Desktop] Failed to resize screenshot:', err)
    return { buffer: pngBuffer, width: originalWidth, height: originalHeight, scale: 1.0 }
  }
}

/**
 * Grid region info - divides image into labeled cells (A1, B2, etc.)
 * Helps vision models precisely identify click targets.
 */
export interface GridRegion {
  cell: string      // e.g., "B2"
  x: number         // Top-left X of cell in image coords
  y: number         // Top-left Y of cell in image coords  
  width: number     // Cell width
  height: number    // Cell height
  centerX: number   // Center X of cell
  centerY: number   // Center Y of cell
}

/**
 * Generate grid regions for an image of given dimensions.
 * Returns array of labeled cells that can be referenced for clicking.
 */
export function generateGridRegions(imageWidth: number, imageHeight: number): GridRegion[] {
  const cellWidth = imageWidth / GRID_COLS
  const cellHeight = imageHeight / GRID_ROWS
  const regions: GridRegion[] = []
  
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const colLabel = String.fromCharCode(65 + col)  // A, B, C, D
      const rowLabel = String(row + 1)                 // 1, 2, 3, 4
      const x = Math.round(col * cellWidth)
      const y = Math.round(row * cellHeight)
      const width = Math.round(cellWidth)
      const height = Math.round(cellHeight)
      
      regions.push({
        cell: `${colLabel}${rowLabel}`,
        x,
        y,
        width,
        height,
        centerX: Math.round(x + width / 2),
        centerY: Math.round(y + height / 2)
      })
    }
  }
  
  return regions
}

/**
 * Get coordinates for a grid cell (e.g., "B2", "F7") within given image dimensions.
 * Returns center coordinates and cell bounds, or null if invalid cell.
 */
export function getGridCellCoords(
  cell: string,
  imageWidth: number,
  imageHeight: number
): GridRegion | null {
  const match = cell.toUpperCase().match(/^([A-H])([1-8])$/)
  if (!match) return null
  
  const col = match[1].charCodeAt(0) - 65  // A=0, B=1, etc.
  const row = parseInt(match[2]) - 1        // 1=0, 2=1, etc.
  
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null
  
  const cellWidth = imageWidth / GRID_COLS
  const cellHeight = imageHeight / GRID_ROWS
  const x = Math.round(col * cellWidth)
  const y = Math.round(row * cellHeight)
  const width = Math.round(cellWidth)
  const height = Math.round(cellHeight)
  
  return {
    cell: `${match[1]}${match[2]}`,
    x,
    y,
    width,
    height,
    centerX: Math.round(x + width / 2),
    centerY: Math.round(y + height / 2)
  }
}

/**
 * Add coordinate grid overlay to a PNG buffer using Jimp.
 * Draws grid lines and optionally a mouse position indicator.
 */
async function addCoordinateGrid(
  pngBuffer: Buffer,
  mousePos?: { x: number; y: number }
): Promise<Buffer> {
  try {
    // Use modern Jimp API
    const { Jimp } = require('jimp')
    const image = await Jimp.read(pngBuffer)
    const width = image.width
    const height = image.height
    const cellWidth = width / GRID_COLS
    const cellHeight = height / GRID_ROWS
    
    // Pre-compute colors as unsigned 32-bit (>>> 0 converts signed to unsigned)
    const gridColor = ((GRID_LINE_COLOR.r << 24) | (GRID_LINE_COLOR.g << 16) | (GRID_LINE_COLOR.b << 8) | GRID_LINE_COLOR.a) >>> 0
    const mouseColor = ((MOUSE_DOT_COLOR.r << 24) | (MOUSE_DOT_COLOR.g << 16) | (MOUSE_DOT_COLOR.b << 8) | MOUSE_DOT_COLOR.a) >>> 0
    
    // Draw vertical grid lines
    for (let col = 1; col < GRID_COLS; col++) {
      const x = Math.round(col * cellWidth)
      for (let y = 0; y < height; y++) {
        // Draw a 2-pixel wide line for visibility
        for (let dx = -1; dx <= 0; dx++) {
          const px = x + dx
          if (px >= 0 && px < width) {
            image.setPixelColor(gridColor, px, y)
          }
        }
      }
    }
    
    // Draw horizontal grid lines
    for (let row = 1; row < GRID_ROWS; row++) {
      const y = Math.round(row * cellHeight)
      for (let x = 0; x < width; x++) {
        for (let dy = -1; dy <= 0; dy++) {
          const py = y + dy
          if (py >= 0 && py < height) {
            image.setPixelColor(gridColor, x, py)
          }
        }
      }
    }
    
    // Draw mouse position indicator (filled circle)
    if (mousePos && mousePos.x >= 0 && mousePos.x < width && mousePos.y >= 0 && mousePos.y < height) {
      const r = MOUSE_DOT_RADIUS
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Check if point is within circle
          if (dx * dx + dy * dy <= r * r) {
            const px = Math.round(mousePos.x + dx)
            const py = Math.round(mousePos.y + dy)
            if (px >= 0 && px < width && py >= 0 && py < height) {
              image.setPixelColor(mouseColor, px, py)
            }
          }
        }
      }
    }
    
    return await image.getBuffer('image/png')
  } catch (err) {
    console.warn('[Desktop] Failed to add coordinate grid:', err)
    return pngBuffer  // Return original on failure
  }
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
  // On Windows, content bounds exclude the DWM shadow
  contentBounds?: { left: number; top: number; width: number; height: number }
  // Offset from outer bounds to content area (for coordinate adjustment)
  shadowOffset?: { left: number; top: number }
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
 * On Windows, returns both outer bounds (with shadow) and content bounds (without shadow)
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
        
        // On Windows, adjust for the invisible DWM extended frame (shadow)
        const isWindows = os.platform() === 'win32'
        const shadowLeft = isWindows ? WINDOWS_SHADOW_LEFT : 0
        const shadowTop = isWindows ? WINDOWS_SHADOW_TOP : 0
        const shadowRight = isWindows ? WINDOWS_SHADOW_RIGHT : 0
        const shadowBottom = isWindows ? WINDOWS_SHADOW_BOTTOM : 0
        
        return {
          title,
          bounds: {
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height
          },
          // Content bounds exclude the shadow (for accurate clicking)
          contentBounds: isWindows ? {
            left: region.left + shadowLeft,
            top: region.top + shadowTop,
            width: region.width - shadowLeft - shadowRight,
            height: region.height - shadowTop - shadowBottom
          } : undefined,
          shadowOffset: isWindows ? { left: shadowLeft, top: shadowTop } : undefined
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

/**
 * Take a screenshot of a specific window and return as PNG buffer.
 * Returns { buffer, bounds, scale, originalWidth, originalHeight, gridRegions } for sending to the agent.
 * Images larger than MAX_SCREENSHOT_DIMENSION are automatically resized.
 * 
 * On Windows, the screenshot EXCLUDES the invisible DWM shadow/border, so coordinates
 * in the image map directly to clickable content.
 * 
 * @param titleQuery - Window title to search for (partial match)
 * @param options.withGrid - If true, overlay a coordinate grid on the screenshot
 */
export async function takeWindowScreenshotBuffer(
  titleQuery: string,
  options?: { withGrid?: boolean }
): Promise<{ 
  buffer: Buffer
  bounds: WindowInfo['bounds']
  contentBounds?: WindowInfo['contentBounds']
  shadowOffset?: WindowInfo['shadowOffset']
  title: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  scale: number
  gridRegions?: GridRegion[]
  mousePosition?: { x: number; y: number }
} | null> {
  const nutjs = getNutJs()
  const windowInfo = await getWindowBounds(titleQuery)
  
  if (!windowInfo) {
    return null
  }
  
  // Focus the window first so it's visible
  await focusWindow(titleQuery)
  await wait(200) // Wait for window to be fully visible
  
  // On Windows, capture only the content area (excluding shadow)
  // This ensures coordinates in the screenshot map directly to clickable content
  const captureRegion = windowInfo.contentBounds || windowInfo.bounds
  
  // Get current mouse position relative to the window content area
  const absoluteMousePos = await getMousePosition()
  const windowRelativeMouseX = absoluteMousePos.x - captureRegion.left
  const windowRelativeMouseY = absoluteMousePos.y - captureRegion.top
  
  // Grab the window region (content only on Windows, full bounds on other platforms)
  const image = await nutjs.screen.grabRegion({
    left: captureRegion.left,
    top: captureRegion.top,
    width: captureRegion.width,
    height: captureRegion.height
  })
  
  // Encode BGRA to PNG
  const pngBuffer = encodeRawBgraToPng(image.data, image.width, image.height)
  
  // Resize if needed to fit vision model limits (uses Electron's nativeImage)
  let { buffer, width, height, scale } = resizePngIfNeeded(pngBuffer, image.width, image.height)
  
  // Scale mouse position to match resized image
  const scaledMouseX = Math.round(windowRelativeMouseX * scale)
  const scaledMouseY = Math.round(windowRelativeMouseY * scale)
  const mouseInWindow = scaledMouseX >= 0 && scaledMouseX < width && scaledMouseY >= 0 && scaledMouseY < height
  
  // Add coordinate grid if requested
  let gridRegions: GridRegion[] | undefined
  if (options?.withGrid) {
    // Pass mouse position to draw indicator
    const mousePos = mouseInWindow ? { x: scaledMouseX, y: scaledMouseY } : undefined
    buffer = await addCoordinateGrid(buffer, mousePos)
    gridRegions = generateGridRegions(width, height)
  }
  
  return { 
    buffer, 
    bounds: windowInfo.bounds,
    contentBounds: windowInfo.contentBounds,
    shadowOffset: windowInfo.shadowOffset,
    title: windowInfo.title,
    width,
    height,
    originalWidth: image.width,
    originalHeight: image.height,
    scale,
    gridRegions,
    mousePosition: mouseInWindow ? { x: scaledMouseX, y: scaledMouseY } : undefined
  }
}
