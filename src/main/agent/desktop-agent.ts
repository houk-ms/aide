import { desktop, isDesktopAvailable, getDesktopUnavailableReason, getAllDisplays, getGridCellCoords } from '../automation'
import type { Tool, SessionConfig, PermissionRequestResult } from '@github/copilot-sdk'
import { getClient, getSelectedModel } from './index'
import { BrowserWindow, app } from 'electron'
import path from 'path'
import fs from 'fs'

// Type alias for session hooks (SDK doesn't export the type)
type SessionHooks = NonNullable<SessionConfig['hooks']>

// Track active desktop sub-agent session for abort handling
let activeDesktopSession: { abort: () => void; disconnect: () => Promise<void> } | null = null

// Track screenshot temp files for cleanup
const screenshotFiles: string[] = []
const MAX_SCREENSHOT_FILES = 20  // Keep at most this many recent screenshots

/** Clean up old screenshot temp files */
function cleanupOldScreenshots(): void {
  while (screenshotFiles.length > MAX_SCREENSHOT_FILES) {
    const oldFile = screenshotFiles.shift()
    if (oldFile) {
      try {
        fs.unlinkSync(oldFile)
      } catch {
        // File may already be deleted
      }
    }
  }
}

/** Track a new screenshot file and cleanup old ones */
function trackScreenshotFile(filePath: string): void {
  screenshotFiles.push(filePath)
  cleanupOldScreenshots()
}

/** Abort the currently running desktop sub-agent (called when user clicks Stop) */
export function abortDesktopSubagent(): void {
  if (activeDesktopSession) {
    activeDesktopSession.abort()
    activeDesktopSession = null
  }
}

// Emit events to all renderer windows (mirrors the main agent's emitEvent)
function emitDesktopEvent(event: { type: string; [key: string]: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', event)
  }
}

// ============================================================
// Desktop Sub-Agent — Specialized agent for desktop automation
// ============================================================
// The main agent sees only `desktop_automation`. When invoked, this module
// spawns an ephemeral sub-session with the full desktop toolkit and a
// specialized system prompt. The sub-agent executes the task and returns
// a summarized result.
// ============================================================

const DESKTOP_AGENT_PROMPT = `You are a desktop automation specialist. Your job is to accomplish tasks by controlling the mouse and keyboard on the user's computer.

## Core Workflow

1. **List windows first**: Call desktop_list_windows to see all available windows and their exact titles.

2. **FOCUS FIRST — MANDATORY**: Before ANY interaction with a window, you MUST call desktop_focus_window to bring it to the foreground. Clicks and keystrokes go to the FOCUSED window, not necessarily the window you screenshotted.

3. **Screenshot to verify**: After focusing, call desktop_screenshot_window. It saves the image to a file and returns the path. Then use the \`view\` tool to see the screenshot.

4. **Check screenshot dimensions**: The screenshot result includes:
   - \`width\`/\`height\`: The image dimensions you see
   - \`originalWidth\`/\`originalHeight\`: The actual window dimensions
   - \`scale\`: If less than 1.0, the image was resized to fit model limits
   
5. **Click with desktop_click_in_window**: When clicking, ALWAYS pass \`imageWidth\` and \`imageHeight\` from the screenshot result. This ensures coordinates are mapped correctly even if the image was resized.

6. **Re-focus after any delay**: If you take multiple actions or there's any pause, RE-FOCUS the window before continuing. Another window may have stolen focus.

7. **Verify after action**: After clicking or typing, take another screenshot to confirm the action succeeded.

## CRITICAL: Focus Rules

- NEVER click or type without calling desktop_focus_window first
- NEVER assume a window is focused just because you screenshotted it
- ALWAYS re-focus if you're unsure or after taking multiple screenshots
- Use desktop_get_active_window to check which window is currently focused

## Screenshot Workflow

1. Call \`desktop_screenshot_window\` with the window title
2. Note the \`width\`, \`height\`, and \`imagePath\` from the result
3. Call \`view\` with the \`imagePath\` to see the screenshot
4. The screenshot has a red 4x4 grid overlay:
   - Columns: A (left), B, C, D (right)
   - Rows: 1 (top), 2, 3, 4 (bottom)
   - Use grid intersections as reference points for coordinates
5. Identify the target element's x, y position from the top-left corner
6. When clicking, pass \`imageWidth\` and \`imageHeight\` from step 2

## Coordinate Handling

Screenshots may be resized to fit vision model limits (max 1600px on any dimension).

When clicking:
1. Use the grid overlay to help estimate coordinates (each cell is 1/4 of the width/height)
2. Identify the element's position in the screenshot image (x, y from top-left)
3. Pass those coordinates to desktop_click_in_window along with imageWidth and imageHeight
4. The tool automatically scales coordinates to the actual window size

Example: Screenshot is 1600x900 pixels
- Grid cell A1 spans x=0-400, y=0-225
- Grid cell B2 spans x=400-800, y=225-450
- A button in the middle of cell C3 would be around (1000, 560)

## Error Recovery

- If a click misses, screenshot and re-analyze the coordinates using the grid
- If a window isn't found, use desktop_list_windows to see available windows
- Report failures clearly so the calling agent can adjust

## Don't Assume Clean State

The user may have been using the application before you were invoked. Never assume the app is in its initial or default state:

- **Scrolling**: If you need to find something in a list or document, try scrolling BOTH up AND down. The target might be above the current view, not just below.
- **Navigation**: Check what's already visible before navigating. The user might already be on the right page/tab.
- **Forms/inputs**: Fields may already have values. Check before typing — you might need to clear first.
- **Dialogs/popups**: Existing modals or alerts might be open. Handle them before proceeding.

When searching for content: screenshot first to see the current position, then explore in both directions if needed.

## Response Format

After completing the task (or if it fails), respond with a clear summary:
- What you did (steps taken)
- Whether it succeeded
- What the current screen state shows
- Any issues encountered`

// ============================================================
// Desktop Tools — Only available to the desktop sub-agent
// ============================================================

const desktopClickTool: Tool<any> = {
  name: 'desktop_click',
  description: 'ADVANCED: Click at absolute screen coordinates. For most cases, use desktop_click_in_window instead — it handles coordinate math automatically. This tool requires you to manually calculate absolute coordinates including multi-monitor offsets.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Absolute X coordinate across all monitors (pixels from left edge of leftmost monitor)' },
      y: { type: 'number', description: 'Absolute Y coordinate (pixels from top edge)' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button to click (default: left)' },
      doubleClick: { type: 'boolean', description: 'Whether to double-click (default: false)' }
    },
    required: ['x', 'y']
  },
  skipPermission: true, // Sub-agent already approved by parent
  handler: async (args: { x: number; y: number; button?: 'left' | 'right'; doubleClick?: boolean }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      if (args.doubleClick) {
        await desktop.doubleClick(args.x, args.y)
      } else {
        await desktop.click(args.x, args.y, args.button || 'left')
      }
      return { success: true, message: `Clicked at (${args.x}, ${args.y})` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopClickInWindowTool: Tool<any> = {
  name: 'desktop_click_in_window',
  description: 'Click at a position RELATIVE to a window. PREREQUISITE: Call desktop_focus_window FIRST. Provide x,y coordinates based on the screenshot image. IMPORTANT: If the screenshot was resized (check the "scale" field in screenshot result), you MUST pass imageWidth and imageHeight from the screenshot result so coordinates are scaled correctly.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title to click in (partial match, case-insensitive)' },
      x: { type: 'number', description: 'X coordinate in the screenshot image (0,0 is top-left)' },
      y: { type: 'number', description: 'Y coordinate in the screenshot image (0,0 is top-left)' },
      imageWidth: { type: 'number', description: 'REQUIRED if screenshot was resized: pass the "width" value from the screenshot result' },
      imageHeight: { type: 'number', description: 'REQUIRED if screenshot was resized: pass the "height" value from the screenshot result' },
      cropOffsetX: { type: 'number', description: 'If clicking based on a cropped region of the screenshot, the X offset where the crop starts' },
      cropOffsetY: { type: 'number', description: 'If clicking based on a cropped region of the screenshot, the Y offset where the crop starts' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button to click (default: left)' },
      doubleClick: { type: 'boolean', description: 'Whether to double-click (default: false)' }
    },
    required: ['title', 'x', 'y']
  },
  skipPermission: true,
  handler: async (args: { title: string; x: number; y: number; cropOffsetX?: number; cropOffsetY?: number; imageWidth?: number; imageHeight?: number; button?: 'left' | 'right'; doubleClick?: boolean }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const windowInfo = await desktop.getWindowBounds(args.title)
      if (!windowInfo) {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
      
      await desktop.focusWindow(args.title)
      
      // Use contentBounds if available (on Windows, excludes shadow)
      // This matches what the screenshot captures
      const clickBounds = windowInfo.contentBounds || windowInfo.bounds
      
      // Warn if window is large but no scaling dimensions provided
      const MAX_DIM = 1600
      const windowMaxDim = Math.max(clickBounds.width, clickBounds.height)
      if (windowMaxDim > MAX_DIM && !args.imageWidth) {
        return {
          success: false,
          error: `Window "${windowInfo.title}" is ${clickBounds.width}x${clickBounds.height} which exceeds ${MAX_DIM}px. Screenshots are resized, so you MUST pass imageWidth and imageHeight from the screenshot result to click accurately. Re-take the screenshot and use its width/height values.`
        }
      }
      
      // Coordinate transformation: screenshot-space → window-space
      // 1. Add crop offset (if agent cropped the screenshot, translate to full-screenshot coords)
      let screenshotX = args.x + (args.cropOffsetX || 0)
      let screenshotY = args.y + (args.cropOffsetY || 0)
      
      // 2. Scale from screenshot dimensions to actual content dimensions
      //    (needed if screenshot was resized to fit vision model limits)
      let contentX = screenshotX
      let contentY = screenshotY
      if (args.imageWidth && args.imageHeight) {
        const scaleX = clickBounds.width / args.imageWidth
        const scaleY = clickBounds.height / args.imageHeight
        contentX = Math.round(screenshotX * scaleX)
        contentY = Math.round(screenshotY * scaleY)
      }
      
      // 3. Convert content-relative to screen-absolute coordinates
      //    clickBounds already accounts for shadow offset on Windows
      const absX = clickBounds.left + contentX
      const absY = clickBounds.top + contentY
      
      if (contentX < 0 || contentX > clickBounds.width || contentY < 0 || contentY > clickBounds.height) {
        return { 
          success: false, 
          error: `Coordinates (${contentX}, ${contentY}) are outside content bounds (${clickBounds.width}x${clickBounds.height}). Window "${windowInfo.title}" content is at screen position (${clickBounds.left}, ${clickBounds.top}).`
        }
      }
      
      if (args.doubleClick) {
        await desktop.doubleClick(absX, absY)
      } else {
        await desktop.click(absX, absY, args.button || 'left')
      }
      
      const cropInfo = (args.cropOffsetX || args.cropOffsetY) ? ` (crop offset: +${args.cropOffsetX || 0}, +${args.cropOffsetY || 0})` : ''
      const scaling = args.imageWidth ? ` (scaled from image ${args.imageWidth}x${args.imageHeight} to content ${clickBounds.width}x${clickBounds.height})` : ''
      const shadowInfo = windowInfo.shadowOffset ? ` (shadow: ${windowInfo.shadowOffset.left}px left, ${windowInfo.shadowOffset.top}px top)` : ''
      return { 
        success: true, 
        message: `Clicked at content (${contentX}, ${contentY}) = screen (${absX}, ${absY}) in "${windowInfo.title}"${cropInfo}${scaling}${shadowInfo}`,
        windowTitle: windowInfo.title,
        contentBounds: clickBounds,
        clickedAt: { content: { x: contentX, y: contentY }, screen: { x: absX, y: absY } }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopTypeTool: Tool<any> = {
  name: 'desktop_type',
  description: 'Type text using the keyboard. PREREQUISITE: Call desktop_focus_window FIRST to ensure the correct window receives input, then click on an input field to place cursor. Text is typed at the current cursor position. TIP: Use desktop_clear_input first if the field already has text.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to type' },
      pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false)' }
    },
    required: ['text']
  },
  skipPermission: true,
  handler: async (args: { text: string; pressEnter?: boolean }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      await desktop.typeText(args.text)
      if (args.pressEnter) {
        await desktop.pressShortcut('Enter')
      }
      return { success: true, message: `Typed: "${args.text.substring(0, 50)}${args.text.length > 50 ? '...' : ''}"${args.pressEnter ? ' + Enter' : ''}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopClearInputTool: Tool<any> = {
  name: 'desktop_clear_input',
  description: 'Clear the currently focused input field by selecting all text and deleting it. PREREQUISITE: Click on the input field first to focus it.',
  parameters: {
    type: 'object',
    properties: {}
  },
  skipPermission: true,
  handler: async () => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      // Select all and delete
      await desktop.pressShortcut('Ctrl+A')
      await desktop.wait(50)
      await desktop.pressShortcut('Delete')
      return { success: true, message: 'Cleared input field (Ctrl+A, Delete)' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopTripleClickTool: Tool<any> = {
  name: 'desktop_triple_click',
  description: 'Triple-click to select an entire line or paragraph. Useful for selecting text before copying or replacing.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title (partial match)' },
      x: { type: 'number', description: 'X coordinate in screenshot' },
      y: { type: 'number', description: 'Y coordinate in screenshot' },
      imageWidth: { type: 'number', description: 'Screenshot width for scaling' },
      imageHeight: { type: 'number', description: 'Screenshot height for scaling' }
    },
    required: ['title', 'x', 'y', 'imageWidth', 'imageHeight']
  },
  skipPermission: true,
  handler: async (args: { title: string; x: number; y: number; imageWidth: number; imageHeight: number }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const windowInfo = await desktop.getWindowBounds(args.title)
      if (!windowInfo) {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
      
      const clickBounds = windowInfo.contentBounds || windowInfo.bounds
      const scaleX = clickBounds.width / args.imageWidth
      const scaleY = clickBounds.height / args.imageHeight
      const absX = clickBounds.left + Math.round(args.x * scaleX)
      const absY = clickBounds.top + Math.round(args.y * scaleY)
      
      await desktop.focusWindow(args.title)
      
      // Triple click with short delays
      await desktop.click(absX, absY, 'left')
      await desktop.wait(50)
      await desktop.click(absX, absY, 'left')
      await desktop.wait(50)
      await desktop.click(absX, absY, 'left')
      
      return { success: true, message: `Triple-clicked at (${absX}, ${absY}) to select line/paragraph` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopWaitTool: Tool<any> = {
  name: 'desktop_wait',
  description: 'Wait for a specified duration. Use this when UI needs time to update after an action (e.g., after clicking a menu, waiting for a dialog to appear).',
  parameters: {
    type: 'object',
    properties: {
      ms: { type: 'number', description: 'Milliseconds to wait (default: 500, max: 5000)' }
    }
  },
  skipPermission: true,
  handler: async (args: { ms?: number }) => {
    const duration = Math.min(args.ms || 500, 5000)
    await desktop.wait(duration)
    return { success: true, message: `Waited ${duration}ms` }
  }
}

const desktopShortcutTool: Tool<any> = {
  name: 'desktop_shortcut',
  description: 'Press a keyboard shortcut (e.g., Ctrl+C, Cmd+V, Alt+Tab). PREREQUISITE: Call desktop_focus_window FIRST to ensure the correct window receives the shortcut. Use "Cmd" for macOS Command key, "Ctrl" for Windows/Linux Control key.',
  parameters: {
    type: 'object',
    properties: {
      shortcut: { type: 'string', description: 'Keyboard shortcut to press (e.g., "Ctrl+C", "Cmd+V", "Alt+Tab", "Ctrl+Shift+S")' }
    },
    required: ['shortcut']
  },
  skipPermission: true,
  handler: async (args: { shortcut: string }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      await desktop.pressShortcut(args.shortcut)
      return { success: true, message: `Pressed: ${args.shortcut}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopScrollTool: Tool<any> = {
  name: 'desktop_scroll',
  description: 'Scroll the mouse wheel in the focused window. PREREQUISITE: Call desktop_focus_window FIRST. Use this to navigate through lists, documents, or any scrollable content. Remember: content might be ABOVE or BELOW the current view — try both directions if you don\'t find what you\'re looking for.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
      amount: { type: 'number', description: 'Scroll amount in pixels (default: 300). Larger values scroll further.' }
    },
    required: ['direction']
  },
  skipPermission: true,
  handler: async (args: { direction: 'up' | 'down'; amount?: number }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const amount = args.amount || 300
      await desktop.scroll(amount, args.direction)
      return { 
        success: true, 
        message: `Scrolled ${args.direction} by ${amount}px. Take a screenshot to see the new view.`
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopScreenshotTool: Tool<any> = {
  name: 'desktop_screenshot',
  description: 'Take a screenshot of a monitor. Defaults to PRIMARY monitor. Returns a base64-encoded PNG image with width/height and the monitor bounds (for coordinate mapping). Use desktop_list_displays first to see available monitors.',
  parameters: {
    type: 'object',
    properties: {
      monitor: { 
        type: 'string', 
        description: 'Which monitor to capture: "primary" (default), "all" (combines all monitors into one wide image), or a display ID from desktop_list_displays',
        enum: ['primary', 'all']
      }
    }
  },
  skipPermission: true,
  handler: async (params: { monitor?: 'primary' | 'all' | number }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const monitor = params.monitor || 'primary'
      const { buffer, width, height, bounds } = await desktop.takeScreenshotBuffer(monitor)
      const base64 = buffer.toString('base64')
      return {
        success: true,
        imageBase64: base64,
        mimeType: 'image/png',
        width,
        height,
        bounds,
        coordinateInfo: `Screenshot is ${width}x${height} pixels from monitor at position (${bounds.x}, ${bounds.y}). When clicking, add bounds.x/bounds.y to convert image coordinates to absolute screen coordinates.`
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopListDisplaysTool: Tool<any> = {
  name: 'desktop_list_displays',
  description: 'List all connected displays/monitors with their bounds, scale factors, and which is primary. Use this to understand the multi-monitor layout before taking screenshots.',
  parameters: {
    type: 'object',
    properties: {}
  },
  skipPermission: true,
  handler: async () => {
    try {
      const displays = getAllDisplays()
      return {
        success: true,
        count: displays.length,
        displays,
        tip: displays.length > 1 
          ? 'Multiple monitors detected. Use desktop_screenshot with monitor="primary" to capture just the primary monitor, or use desktop_screenshot_window to capture a specific window.'
          : 'Single monitor setup.'
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopListWindowsTool: Tool<any> = {
  name: 'desktop_list_windows',
  description: 'List all open windows with their titles and absolute screen bounds. Use this to discover running applications.',
  parameters: {
    type: 'object',
    properties: {}
  },
  skipPermission: true,
  handler: async () => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const windows = await desktop.listWindows()
      return {
        success: true,
        count: windows.length,
        windows: windows.map(w => ({
          title: w.title,
          left: w.bounds.left,
          top: w.bounds.top,
          width: w.bounds.width,
          height: w.bounds.height
        }))
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopFocusWindowTool: Tool<any> = {
  name: 'desktop_focus_window',
  description: 'MANDATORY FIRST STEP: Focus (bring to front) a window by its title. You MUST call this before clicking or typing — actions go to the focused window, not necessarily the one you screenshotted. Partial, case-insensitive title matching.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title to search for (partial match, case-insensitive)' }
    },
    required: ['title']
  },
  skipPermission: true,
  handler: async (args: { title: string }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const found = await desktop.focusWindow(args.title)
      if (found) {
        return { success: true, message: `Focused window matching "${args.title}"` }
      } else {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopGetActiveWindowTool: Tool<any> = {
  name: 'desktop_get_active_window',
  description: 'Get the currently focused/active window title and bounds.',
  parameters: {
    type: 'object',
    properties: {}
  },
  skipPermission: true,
  handler: async () => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const window = await desktop.getActiveWindow()
      if (window) {
        return {
          success: true,
          title: window.title,
          left: window.bounds.left,
          top: window.bounds.top,
          width: window.bounds.width,
          height: window.bounds.height
        }
      } else {
        return { success: false, error: 'Could not determine active window' }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopGetWindowBoundsTool: Tool<any> = {
  name: 'desktop_get_window_bounds',
  description: 'Get absolute screen bounds of a window by title.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title to search for (partial match, case-insensitive)' }
    },
    required: ['title']
  },
  skipPermission: true,
  handler: async (args: { title: string }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const window = await desktop.getWindowBounds(args.title)
      if (window) {
        return {
          success: true,
          title: window.title,
          left: window.bounds.left,
          top: window.bounds.top,
          width: window.bounds.width,
          height: window.bounds.height
        }
      } else {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopClickGridCellTool: Tool<any> = {
  name: 'desktop_click_grid_cell',
  description: 'Click the center of a grid cell (A1-D4) in a window. PREREQUISITE: Take a screenshot with withGrid=true first. The grid divides the window into a 4x4 matrix: columns A-D (left to right), rows 1-4 (top to bottom). Use this for rough targeting when exact pixel coordinates are hard to determine.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title to click in (partial match)' },
      cell: { type: 'string', description: 'Grid cell to click (e.g., "B2", "C3"). Columns A-D, rows 1-4.' },
      imageWidth: { type: 'number', description: 'Width from the screenshot result (required for coordinate scaling)' },
      imageHeight: { type: 'number', description: 'Height from the screenshot result (required for coordinate scaling)' },
      offsetX: { type: 'number', description: 'Optional X offset from cell center (positive = right, negative = left)' },
      offsetY: { type: 'number', description: 'Optional Y offset from cell center (positive = down, negative = up)' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default: left)' },
      doubleClick: { type: 'boolean', description: 'Whether to double-click (default: false)' }
    },
    required: ['title', 'cell', 'imageWidth', 'imageHeight']
  },
  skipPermission: true,
  handler: async (args: { 
    title: string
    cell: string
    imageWidth: number
    imageHeight: number
    offsetX?: number
    offsetY?: number
    button?: 'left' | 'right'
    doubleClick?: boolean 
  }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      const windowInfo = await desktop.getWindowBounds(args.title)
      if (!windowInfo) {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
      
      // Use contentBounds if available (on Windows, excludes shadow)
      const clickBounds = windowInfo.contentBounds || windowInfo.bounds
      
      // Get grid cell coordinates
      const gridCoords = desktop.getGridCellCoords(args.cell, args.imageWidth, args.imageHeight)
      if (!gridCoords) {
        return { success: false, error: `Invalid grid cell "${args.cell}". Use A1-D4 (columns A-D, rows 1-4).` }
      }
      
      // Apply optional offset
      const screenshotX = gridCoords.centerX + (args.offsetX || 0)
      const screenshotY = gridCoords.centerY + (args.offsetY || 0)
      
      // Scale from screenshot to content dimensions
      const scaleX = clickBounds.width / args.imageWidth
      const scaleY = clickBounds.height / args.imageHeight
      const contentX = Math.round(screenshotX * scaleX)
      const contentY = Math.round(screenshotY * scaleY)
      
      // Convert to absolute screen coordinates
      const absX = clickBounds.left + contentX
      const absY = clickBounds.top + contentY
      
      await desktop.focusWindow(args.title)
      
      if (args.doubleClick) {
        await desktop.doubleClick(absX, absY)
      } else {
        await desktop.click(absX, absY, args.button || 'left')
      }
      
      const offsetInfo = (args.offsetX || args.offsetY) 
        ? ` with offset (${args.offsetX || 0}, ${args.offsetY || 0})` 
        : ''
      
      return {
        success: true,
        message: `Clicked center of cell ${args.cell}${offsetInfo} → content (${contentX}, ${contentY}) → screen (${absX}, ${absY})`,
        cell: args.cell,
        cellBounds: gridCoords,
        clickedAt: {
          screenshot: { x: screenshotX, y: screenshotY },
          content: { x: contentX, y: contentY },
          screen: { x: absX, y: absY }
        }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopScreenshotWindowTool: Tool<any> = {
  name: 'desktop_screenshot_window',
  description: 'Take a screenshot of a specific window by title. The screenshot includes a 4x4 grid overlay (cells A1-D4) to help identify click regions. Saves to a temp file and returns the path. Use the built-in `view` tool to see the image.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title to search for (partial match, case-insensitive)' }
    },
    required: ['title']
  },
  skipPermission: true,
  handler: async (args: { title: string }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      // Always use grid overlay for easier coordinate identification
      const result = await desktop.takeWindowScreenshotBuffer(args.title, { withGrid: true })
      if (result) {
        const wasResized = result.scale < 1.0
        
        // Save to temp file so SDK's view tool can display it
        const tempDir = app.getPath('temp')
        const filename = `desktop-screenshot-${Date.now()}.png`
        const filePath = path.join(tempDir, filename)
        fs.writeFileSync(filePath, result.buffer)
        trackScreenshotFile(filePath)  // Track for cleanup
        
        // Build grid cell info for easy reference
        const gridCells = result.gridRegions?.map(r => ({
          cell: r.cell,
          centerX: r.centerX,
          centerY: r.centerY
        })) || []
        
        return {
          success: true,
          // File path for viewing with the `view` tool
          imagePath: filePath,
          // Window info
          title: result.title,
          // Dimensions of the screenshot image (may be resized)
          width: result.width,
          height: result.height,
          // Original window dimensions (for coordinate mapping)
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
          // Scale factor applied (1.0 = no resize)
          scale: result.scale,
          // Grid info - screenshot has red grid lines dividing it into 4x4 cells
          grid: {
            description: 'Screenshot has a 4x4 grid overlay. Columns A-D (left to right), Rows 1-4 (top to bottom).',
            cells: gridCells
          },
          // Instructions
          nextStep: `Use the \`view\` tool to see the screenshot at: ${filePath}`,
          coordinateHelp: wasResized
            ? `IMPORTANT: Image was resized from ${result.originalWidth}x${result.originalHeight} to ${result.width}x${result.height} (scale: ${result.scale.toFixed(2)}). When calling desktop_click_in_window, you MUST pass imageWidth=${result.width} and imageHeight=${result.height} so coordinates are scaled correctly.`
            : `Image is at original size: ${result.width}x${result.height}. When clicking, pass imageWidth=${result.width} and imageHeight=${result.height}.`
        }
      } else {
        return { success: false, error: `No window found matching "${args.title}"` }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

// All tools available to the desktop sub-agent
const desktopTools: Tool<any>[] = [
  desktopListWindowsTool,       // Start here to find window titles
  desktopFocusWindowTool,       // MUST call before any interaction
  desktopScreenshotWindowTool,  // Call after focus to verify state
  desktopGetActiveWindowTool,   // Check which window is currently focused
  desktopClickInWindowTool,     // Primary click tool (requires prior focus)
  desktopTypeTool,              // Requires prior focus
  desktopClearInputTool,        // Clear input field before typing
  desktopShortcutTool,          // Requires prior focus
  desktopScrollTool,            // Requires prior focus — try both up AND down
]

// ============================================================
// Sub-Agent Runner
// ============================================================

interface DesktopTaskResult {
  success: boolean
  summary: string
  steps?: string[]
  error?: string
}

// Summarize tool input for display (avoid huge base64 in screenshots)
function summarizeToolInput(toolName: string, args: Record<string, unknown>): string {
  if (toolName.includes('screenshot')) {
    const title = args.title || 'screen'
    return `Taking screenshot of ${title}`
  }
  if (toolName === 'desktop_click_in_window') {
    const title = args.title || 'window'
    return `Click at (${args.x}, ${args.y}) in ${title}`
  }
  if (toolName === 'desktop_type') {
    const text = String(args.text || '').slice(0, 30)
    const enter = args.pressEnter ? ' + Enter' : ''
    return `Type: "${text}${String(args.text || '').length > 30 ? '...' : ''}"${enter}`
  }
  if (toolName === 'desktop_clear_input') {
    return 'Clear input field'
  }
  if (toolName === 'desktop_shortcut') {
    return `Press: ${args.shortcut}`
  }
  if (toolName === 'desktop_scroll') {
    return `Scroll ${args.direction} by ${args.amount || 300}px`
  }
  if (toolName === 'desktop_focus_window') {
    return `Focus window: ${args.title}`
  }
  if (toolName === 'desktop_get_active_window') {
    return 'Get active window'
  }
  if (toolName === 'desktop_list_windows') {
    return 'List all windows'
  }
  return JSON.stringify(args).slice(0, 80)
}

/**
 * Run a desktop automation task in an isolated sub-session.
 * The sub-agent has access to all desktop tools and a specialized prompt.
 * Tool calls and progress are streamed to the UI via events.
 */
export async function runDesktopSubagent(
  task: string,
  windowTitle?: string
): Promise<DesktopTaskResult> {
  const client = getClient()
  if (!client) {
    return { success: false, summary: '', error: 'Copilot SDK not initialized' }
  }

  if (!isDesktopAvailable()) {
    return { success: false, summary: '', error: getDesktopUnavailableReason() }
  }

  const sessionId = `desktop-${Date.now()}`
  console.log(`[Desktop] Starting subagent | session: ${sessionId} | task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''} | window: ${windowTitle || 'none'}`)
  const prompt = windowTitle
    ? `Task: ${task}\nTarget window: "${windowTitle}"\n\nStart by listing windows to find the exact title, then focus and screenshot the target window.`
    : `Task: ${task}\n\nStart by listing windows to see what's available, then focus and screenshot the relevant window.`

  // Track tool calls for the result summary
  const toolSteps: string[] = []
  const toolTimestamps = new Map<string, number>()

  // Hooks to emit events for sub-agent tool calls (visible in UI)
  const hooks: SessionHooks = {
    onPreToolUse: async (input: any) => {
      const toolName = input.toolName || ''
      const toolCallId = input.toolCallId || `desktop-tc-${Date.now()}`
      const inputPreview = summarizeToolInput(toolName, input.toolArgs || {})
      
      toolTimestamps.set(toolCallId, Date.now())
      toolSteps.push(inputPreview)
      
      // Log to console for debugging
      console.log(`[Desktop] tool_pre: ${toolName} | args: ${JSON.stringify(input.toolArgs || {}).slice(0, 300)}`)
      
      // Emit event so UI shows the sub-agent's tool call
      emitDesktopEvent({
        type: 'chat:tool-use',
        taskId: null,
        record: {
          id: toolCallId,
          toolName: `desktop:${toolName}`,  // Prefix to show it's from sub-agent
          status: 'running',
          timestamp: new Date().toISOString(),
          inputPreview
        }
      })
      
      return undefined  // Allow all tools
    },
    
    onPostToolUse: async (input: any) => {
      const toolName = input.toolName || ''
      const toolCallId = input.toolCallId || ''
      const startTime = toolTimestamps.get(toolCallId)
      const durationMs = startTime ? Date.now() - startTime : undefined
      toolTimestamps.delete(toolCallId)
      
      // Summarize result (avoid huge base64 screenshots)
      const result = input.toolResult || {}
      let resultPreview = ''
      if (result.success === false) {
        resultPreview = `Error: ${result.error || 'unknown'}`
      } else if (result.imagePath) {
        // Screenshot saved to file
        resultPreview = `Screenshot saved (${result.width}x${result.height}, original: ${result.originalWidth}x${result.originalHeight}, scale: ${result.scale})`
      } else if (result.imageBase64) {
        // Legacy base64 screenshot
        resultPreview = `Screenshot captured (${result.width}x${result.height})`
      } else if (result.message) {
        resultPreview = result.message
      } else {
        resultPreview = JSON.stringify(result).slice(0, 100)
      }
      
      // Log to console for debugging
      console.log(`[Desktop] tool_post: ${toolName} | ${durationMs}ms | ${resultPreview}`)
      
      emitDesktopEvent({
        type: 'chat:tool-use',
        taskId: null,
        record: {
          id: toolCallId,
          toolName: `desktop:${toolName}`,
          status: result.success === false ? 'error' : 'done',
          timestamp: new Date().toISOString(),
          durationMs,
          resultPreview
        }
      })
    }
  }

  try {
    const config: Partial<SessionConfig> = {
      sessionId,
      model: getSelectedModel(),
      streaming: true,  // Enable streaming for progress visibility
      tools: desktopTools,
      hooks,  // Add hooks to emit tool events
      infiniteSessions: { enabled: false },  // Ephemeral session
      systemMessage: { content: DESKTOP_AGENT_PROMPT },
      onPermissionRequest: () => ({ kind: 'approve-once' as const })  // Auto-approve within sub-agent
    }

    const session = await client.createSession(config as SessionConfig)
    activeDesktopSession = session
    
    // Signal that desktop sub-agent is starting
    emitDesktopEvent({
      type: 'desktop:subagent-start',
      taskId: null,
      task
    })
    
    // Run with event subscription to capture streaming output
    return new Promise((resolve) => {
      let finalMessage = ''
      let streamed = ''
      let aborted = false
      
      const unsubscribe = session.on((event: any) => {
        switch (event.type) {
          case 'assistant.message_delta': {
            const delta = event.data?.deltaContent || ''
            if (delta) {
              streamed += delta
              // Emit to UI so user sees the sub-agent's thinking
              emitDesktopEvent({
                type: 'chat:stream',
                taskId: null,  // Desktop agent runs in main chat
                delta,
                source: 'desktop-subagent'
              })
            }
            break
          }
          case 'assistant.message': {
            const content = event.data?.content || ''
            if (content) finalMessage = content
            break
          }
          case 'session.idle': {
            // Sub-agent finished
            unsubscribe()
            activeDesktopSession = null
            session.disconnect().catch(() => {})
            client.deleteSession(sessionId).catch(() => {})
            
            const result = {
              success: !aborted,
              summary: aborted ? '' : (finalMessage || streamed || 'Task completed'),
              error: aborted ? 'Cancelled by user' : undefined,
              steps: toolSteps.length > 0 ? toolSteps : undefined
            }
            
            console.log(`[Desktop] Subagent finished | session: ${sessionId} | success: ${result.success} | steps: ${toolSteps.length}`)
            
            // Signal completion
            emitDesktopEvent({
              type: 'desktop:subagent-end',
              taskId: null,
              success: !aborted
            })
            
            resolve(result)
            break
          }
          case 'session.error': {
            unsubscribe()
            activeDesktopSession = null
            session.disconnect().catch(() => {})
            client.deleteSession(sessionId).catch(() => {})
            
            const errorMsg = event.data?.message || 'Desktop agent error'
            console.error(`[Desktop] Subagent error | session: ${sessionId} | error: ${errorMsg}`)
            
            // Signal error
            emitDesktopEvent({
              type: 'desktop:subagent-end',
              taskId: null,
              success: false,
              error: errorMsg
            })
            
            resolve({
              success: false,
              summary: '',
              error: errorMsg,
              steps: toolSteps.length > 0 ? toolSteps : undefined
            })
            break
          }
          case 'abort': {
            // User clicked Stop
            aborted = true
            // session.idle will follow shortly, resolve there
            break
          }
        }
      })
      
      // Start the sub-agent
      session.send({ prompt }).catch((err: any) => {
        unsubscribe()
        activeDesktopSession = null
        session.disconnect().catch(() => {})
        client.deleteSession(sessionId).catch(() => {})
        
        resolve({
          success: false,
          summary: '',
          error: err.message || 'Failed to send prompt to desktop agent'
        })
      })
    })
  } catch (err: any) {
    return {
      success: false,
      summary: '',
      error: `Failed to create desktop session: ${err.message}`
    }
  }
}

// ============================================================
// Meta-Tool — Exposed to the main agent
// ============================================================

export const desktopAutomationTool: Tool<any> = {
  name: 'desktop_automation',
  description: 'Perform a task on the desktop by controlling mouse and keyboard. Describe WHAT you want to accomplish (e.g., "Click the Send button in Outlook", "Type hello in the VS Code terminal", "Open the File menu in Chrome"). A specialized desktop agent handles the low-level interactions. This is the ONLY desktop tool you need — do not look for individual click/type/screenshot tools.',
  parameters: {
    type: 'object',
    properties: {
      task: { 
        type: 'string', 
        description: 'Natural language description of the desktop task to perform. Be specific about what to click, type, or interact with.' 
      },
      windowTitle: { 
        type: 'string', 
        description: 'Optional: specific window title to target (partial match). Helps the agent find the right window faster.' 
      }
    },
    required: ['task']
  },
  skipPermission: false,  // Require confirmation for desktop automation
  handler: async (args: { task: string; windowTitle?: string }) => {
    const result = await runDesktopSubagent(args.task, args.windowTitle)
    
    if (result.success) {
      return {
        success: true,
        result: result.summary,
        message: 'Desktop task completed successfully'
      }
    } else {
      return {
        success: false,
        error: result.error,
        message: 'Desktop task failed'
      }
    }
  }
}
