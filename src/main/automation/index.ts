// ============================================================
// Automation Module — Browser & Desktop automation capabilities
// ============================================================

export * as browser from './browser'
export * as desktop from './desktop'

export { isBrowserAvailable, closeBrowser } from './browser'
export { isDesktopAvailable, getDesktopUnavailableReason, getAllDisplays, getPrimaryDisplayBounds } from './desktop'
