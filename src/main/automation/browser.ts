import type { Browser, BrowserContext, Page, BrowserType } from 'playwright-core'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'

// Use Node's createRequire to bypass vite's bundler
// playwright-core has internal dynamic requires that don't work with vite
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core') as { chromium: BrowserType<Browser> }

// ============================================================
// Browser Automation Module — Playwright-based web automation
// ============================================================

let browser: Browser | null = null
let context: BrowserContext | null = null
let activePage: Page | null = null

/**
 * Get the bundled Chromium executable path.
 * In packaged app: extraResources/browsers/chromium-xxx/chrome-{platform}/chrome
 * In development: uses Playwright's default cache location
 */
function getChromiumPath(): string | undefined {
  if (!app.isPackaged) {
    // Development: let Playwright find it from default cache
    return undefined
  }

  const browsersDir = path.join(process.resourcesPath, 'browsers')
  if (!fs.existsSync(browsersDir)) {
    console.warn('[Browser] No bundled browsers directory found')
    return undefined
  }

  // Find chromium directory (chromium-xxxx)
  const chromiumDir = fs.readdirSync(browsersDir).find(d => d.startsWith('chromium-'))
  if (!chromiumDir) {
    console.warn('[Browser] No chromium directory found in browsers/')
    return undefined
  }

  const chromiumBase = path.join(browsersDir, chromiumDir)

  // Platform-specific executable path
  // Note: Playwright 1.50+ uses chrome-win64/chrome-mac-arm64 on some platforms
  let execPath: string
  switch (process.platform) {
    case 'darwin':
      // Try arm64 first, then x64
      const macArm64 = path.join(chromiumBase, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      const macX64 = path.join(chromiumBase, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      execPath = fs.existsSync(macArm64) ? macArm64 : macX64
      break
    case 'win32':
      // Try win64 first (Playwright 1.50+), then win (older versions)
      const win64 = path.join(chromiumBase, 'chrome-win64', 'chrome.exe')
      const win32 = path.join(chromiumBase, 'chrome-win', 'chrome.exe')
      execPath = fs.existsSync(win64) ? win64 : win32
      break
    case 'linux':
      execPath = path.join(chromiumBase, 'chrome-linux', 'chrome')
      break
    default:
      return undefined
  }

  if (fs.existsSync(execPath)) {
    return execPath
  }

  console.warn(`[Browser] Chromium executable not found at ${execPath}`)
  return undefined
}

/**
 * Launch browser if not already running
 */
export async function ensureBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser
  }

  const executablePath = getChromiumPath()
  console.log(`[Browser] Launching Chromium${executablePath ? ` from ${executablePath}` : ' (default)'}`)

  browser = await chromium.launch({
    executablePath,
    headless: false, // Show browser for user visibility
    args: [
      '--disable-blink-features=AutomationControlled', // Avoid bot detection
      '--no-first-run',
      '--no-default-browser-check'
    ]
  })

  browser.on('disconnected', () => {
    browser = null
    context = null
    activePage = null
  })

  return browser
}

/**
 * Get or create a browser context (isolated session)
 */
export async function ensureContext(): Promise<BrowserContext> {
  if (context) return context

  const b = await ensureBrowser()
  context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })

  return context
}

/**
 * Navigate to a URL and return the page
 */
export async function navigateTo(url: string): Promise<Page> {
  const ctx = await ensureContext()

  if (!activePage || activePage.isClosed()) {
    activePage = await ctx.newPage()
  }

  await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  return activePage
}

/**
 * Get the current active page
 */
export function getActivePage(): Page | null {
  return activePage && !activePage.isClosed() ? activePage : null
}

/**
 * Click an element by selector
 */
export async function clickElement(selector: string): Promise<void> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  await activePage.click(selector, { timeout: 10000 })
}

/**
 * Type text into an element
 */
export async function typeIntoElement(selector: string, text: string): Promise<void> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  await activePage.fill(selector, text, { timeout: 10000 })
}

/**
 * Get text content of an element
 */
export async function getElementText(selector: string): Promise<string> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  const element = await activePage.waitForSelector(selector, { timeout: 10000 })
  return (await element?.textContent()) || ''
}

/**
 * Take a screenshot of the current page
 */
export async function takeScreenshot(): Promise<Buffer> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  return await activePage.screenshot({ type: 'png' })
}

/**
 * Get the current page URL
 */
export function getCurrentUrl(): string {
  if (!activePage) return ''
  return activePage.url()
}

/**
 * Get the current page title
 */
export async function getPageTitle(): Promise<string> {
  if (!activePage) return ''
  return await activePage.title()
}

/**
 * Wait for an element to appear
 */
export async function waitForElement(selector: string, timeout = 10000): Promise<void> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  await activePage.waitForSelector(selector, { timeout })
}

/**
 * Execute JavaScript in the page context
 */
export async function evaluateScript<T>(script: string): Promise<T> {
  if (!activePage) throw new Error('No active page. Navigate to a URL first.')
  return await activePage.evaluate(script)
}

/**
 * Close the browser completely
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    context = null
    activePage = null
  }
}

/**
 * Check if browser automation is available (Chromium found)
 */
export function isBrowserAvailable(): boolean {
  if (!app.isPackaged) return true // Dev mode uses Playwright cache
  return !!getChromiumPath()
}
