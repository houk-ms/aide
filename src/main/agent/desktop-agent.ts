import { desktop, isDesktopAvailable, getDesktopUnavailableReason, getAllDisplays } from '../automation'
import type { Tool, SessionConfig, PermissionRequestResult, SessionHooks, Session } from '@github/copilot-sdk'
import { getClient, getSelectedModel } from './index'
import { BrowserWindow } from 'electron'

// Track active desktop sub-agent session for abort handling
let activeDesktopSession: Session | null = null

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

1. **FOCUS FIRST — MANDATORY**: Before ANY interaction with a window, you MUST call desktop_focus_window to bring it to the foreground. Clicks and keystrokes go to the FOCUSED window, not necessarily the window you screenshotted. Skipping this step will cause your actions to hit the wrong window.

2. **Screenshot to verify focus**: After focusing, call desktop_screenshot_window to confirm the correct window is active and see its current state.

3. **Check screenshot dimensions**: The screenshot result includes:
   - \`width\`/\`height\`: The image dimensions you see
   - \`originalWidth\`/\`originalHeight\`: The actual window dimensions
   - \`scale\`: If less than 1.0, the image was resized to fit model limits
   
4. **Click with desktop_click_in_window**: When clicking, ALWAYS pass \`imageWidth\` and \`imageHeight\` from the screenshot result. This ensures coordinates are mapped correctly even if the image was resized.

5. **Re-focus after any delay**: If you take multiple actions or there's any pause, RE-FOCUS the window before continuing. Another window may have stolen focus.

6. **Verify after action**: After clicking or typing, take another screenshot to confirm the action succeeded.

## CRITICAL: Focus Rules

- NEVER click or type without calling desktop_focus_window first
- NEVER assume a window is focused just because you screenshotted it
- ALWAYS re-focus if you're unsure or after taking multiple screenshots
- DO NOT click on a window to focus it — use desktop_focus_window instead

## Coordinate Handling

Screenshots may be resized to fit vision model limits (max 1600px on any dimension).

When clicking:
1. Identify the element's position in the screenshot image (x, y from top-left)
2. Pass those coordinates to desktop_click_in_window along with imageWidth and imageHeight
3. The tool automatically scales coordinates to the actual window size

Example: Screenshot shows a button at (400, 200) in a 1600x900 image
→ Call: desktop_click_in_window(title="...", x=400, y=200, imageWidth=1600, imageHeight=900)
→ Tool scales to original window and clicks at the correct position

If you crop an image for analysis, also pass cropOffsetX/cropOffsetY.

## Error Recovery

- If a click misses, screenshot and re-analyze
- If a window isn't found, use desktop_list_windows to see available windows
- Report failures clearly so the calling agent can adjust

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
      
      // Apply crop offset first (translate from crop-relative to window-relative)
      let windowX = args.x + (args.cropOffsetX || 0)
      let windowY = args.y + (args.cropOffsetY || 0)
      
      // Scale coordinates if image dimensions provided
      if (args.imageWidth && args.imageHeight) {
        const scaleX = windowInfo.bounds.width / args.imageWidth
        const scaleY = windowInfo.bounds.height / args.imageHeight
        windowX = Math.round(windowX * scaleX)
        windowY = Math.round(windowY * scaleY)
      }
      
      const absX = windowInfo.bounds.left + windowX
      const absY = windowInfo.bounds.top + windowY
      
      if (windowX < 0 || windowX > windowInfo.bounds.width || windowY < 0 || windowY > windowInfo.bounds.height) {
        return { 
          success: false, 
          error: `Coordinates (${windowX}, ${windowY}) are outside window bounds (${windowInfo.bounds.width}x${windowInfo.bounds.height}). Window "${windowInfo.title}" is at screen position (${windowInfo.bounds.left}, ${windowInfo.bounds.top}).`
        }
      }
      
      if (args.doubleClick) {
        await desktop.doubleClick(absX, absY)
      } else {
        await desktop.click(absX, absY, args.button || 'left')
      }
      
      const cropInfo = (args.cropOffsetX || args.cropOffsetY) ? ` (crop offset: +${args.cropOffsetX || 0}, +${args.cropOffsetY || 0})` : ''
      const scaling = args.imageWidth ? ` (scaled from image ${args.imageWidth}x${args.imageHeight} to window ${windowInfo.bounds.width}x${windowInfo.bounds.height})` : ''
      return { 
        success: true, 
        message: `Clicked at window-relative (${windowX}, ${windowY}) = screen absolute (${absX}, ${absY}) in "${windowInfo.title}"${cropInfo}${scaling}`,
        windowTitle: windowInfo.title,
        windowBounds: windowInfo.bounds,
        clickedAt: { relative: { x: windowX, y: windowY }, absolute: { x: absX, y: absY } }
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const desktopTypeTool: Tool<any> = {
  name: 'desktop_type',
  description: 'Type text using the keyboard. PREREQUISITE: Call desktop_focus_window FIRST to ensure the correct window receives input, then click on an input field to place cursor. Text is typed at the current cursor position.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to type' }
    },
    required: ['text']
  },
  skipPermission: true,
  handler: async (args: { text: string }) => {
    if (!isDesktopAvailable()) {
      return { success: false, error: getDesktopUnavailableReason() }
    }
    try {
      await desktop.typeText(args.text)
      return { success: true, message: `Typed: "${args.text.substring(0, 50)}${args.text.length > 50 ? '...' : ''}"` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
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

const desktopScreenshotWindowTool: Tool<any> = {
  name: 'desktop_screenshot_window',
  description: 'Take a screenshot of a specific window by title. Returns base64 PNG with actual dimensions. Call AFTER desktop_focus_window to verify the window is active and see its state before interacting.',
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
      const result = await desktop.takeWindowScreenshotBuffer(args.title)
      if (result) {
        const base64 = result.buffer.toString('base64')
        const wasResized = result.scale < 1.0
        
        return {
          success: true,
          imageBase64: base64,
          mimeType: 'image/png',
          title: result.title,
          // Dimensions of the image you're seeing
          width: result.width,
          height: result.height,
          // Original window dimensions (for coordinate mapping)
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
          // Scale factor applied (1.0 = no resize)
          scale: result.scale,
          // Clear instructions for the agent
          coordinateHelp: wasResized
            ? `Image was resized from ${result.originalWidth}x${result.originalHeight} to ${result.width}x${result.height} (scale: ${result.scale.toFixed(2)}). When clicking, your coordinates will be automatically scaled back to original size.`
            : `Image is at original size: ${result.width}x${result.height}. Coordinates can be used directly.`
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
  desktopFocusWindowTool,       // MUST call first before any interaction
  desktopScreenshotWindowTool,  // Call after focus to verify state
  desktopClickInWindowTool,     // Primary click tool (requires prior focus)
  desktopTypeTool,              // Requires prior focus
  desktopShortcutTool,          // Requires prior focus
  desktopListWindowsTool,
  desktopGetActiveWindowTool,
  desktopGetWindowBoundsTool,
  // Note: desktop_screenshot (full monitor) intentionally excluded to avoid
  // confusion — agent should always target specific windows with focus workflow
  desktopClickTool,             // Advanced fallback for absolute coordinates
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
  if (toolName === 'desktop_click' || toolName === 'desktop_click_in_window') {
    const title = args.title || 'screen'
    return `Click at (${args.x}, ${args.y}) in ${title}`
  }
  if (toolName === 'desktop_type') {
    const text = String(args.text || '').slice(0, 30)
    return `Type: "${text}${String(args.text || '').length > 30 ? '...' : ''}"`
  }
  if (toolName === 'desktop_shortcut') {
    return `Press: ${args.shortcut}`
  }
  if (toolName === 'desktop_focus_window') {
    return `Focus window: ${args.title}`
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
  const prompt = windowTitle
    ? `Task: ${task}\nTarget window: "${windowTitle}"\n\nStart by taking a screenshot of the target window to see its current state.`
    : `Task: ${task}\n\nStart by listing windows or taking a screenshot to see what's available.`

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
      } else if (result.imageBase64) {
        resultPreview = `Screenshot captured (${result.width}x${result.height})`
      } else if (result.message) {
        resultPreview = result.message
      } else {
        resultPreview = JSON.stringify(result).slice(0, 100)
      }
      
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
            
            // Signal completion
            emitDesktopEvent({
              type: 'desktop:subagent-end',
              taskId: null,
              success: !aborted
            })
            
            resolve({
              success: !aborted,
              summary: aborted ? '' : (finalMessage || streamed || 'Task completed'),
              error: aborted ? 'Cancelled by user' : undefined,
              steps: toolSteps.length > 0 ? toolSteps : undefined
            })
            break
          }
          case 'session.error': {
            unsubscribe()
            activeDesktopSession = null
            session.disconnect().catch(() => {})
            client.deleteSession(sessionId).catch(() => {})
            
            // Signal error
            emitDesktopEvent({
              type: 'desktop:subagent-end',
              taskId: null,
              success: false,
              error: event.data?.message || 'Desktop agent error'
            })
            
            resolve({
              success: false,
              summary: '',
              error: event.data?.message || 'Desktop agent error',
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
