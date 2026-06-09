/**
 * Marketplace sources module - manages skill marketplace sources and browsing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  MarketplaceSource,
  MarketplaceManifest,
  MarketplaceSkillEntry,
  BrowsableSkill,
  Skill
} from '@shared/types'
import { getSkillsDirectory, listSkills } from './index'

// ─── Default Sources ─────────────────────────────────────────────────

const DEFAULT_SOURCES: MarketplaceSource[] = [
  {
    id: 'awesome-skills',
    name: 'Skills Marketplace',
    type: 'community',
    url: 'https://github.com/sickn33/antigravity-awesome-skills',
    branch: 'main',
    enabled: true,
    lastSyncedAt: null,
    skillCount: 0
  }
]

// ─── Paths ───────────────────────────────────────────────────────────

function getAideConfigDir(): string {
  const dir = path.join(os.homedir(), '.aide')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getCacheDir(): string {
  const dir = path.join(getAideConfigDir(), 'marketplace-cache')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getCachedManifestPath(sourceId: string): string {
  return path.join(getCacheDir(), `${sourceId}.json`)
}

// ─── Sources ─────────────────────────────────────────────────────────
// Sources are a fixed, curated set (no user-managed custom sources).
// listSources reads each source's skillCount/lastSync from its cached manifest.

/**
 * List marketplace sources. For each, reads skillCount from cached manifest.
 */
export function listSources(): MarketplaceSource[] {
  return DEFAULT_SOURCES.map(source => {
    const cached = getCachedManifest(source.id)
    return {
      ...source,
      skillCount: cached?.skills.length || 0,
      lastSyncedAt: cached ? getManifestCacheTime(source.id) : null
    }
  })
}

/**
 * Get cache file modification time as ISO string.
 */
function getManifestCacheTime(sourceId: string): string | null {
  const cachePath = getCachedManifestPath(sourceId)
  if (!fs.existsSync(cachePath)) return null
  try {
    const stat = fs.statSync(cachePath)
    return stat.mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * Get a single source by ID.
 */
export function getSource(id: string): MarketplaceSource | null {
  return listSources().find(s => s.id === id) || null
}

// ─── Manifest Fetching ───────────────────────────────────────────────

/**
 * Parse GitHub repo URL to owner/repo.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * Fetch marketplace.json from a source.
 * Falls back to scanning for SKILL.md files if no marketplace.json exists.
 */
export async function fetchManifest(source: MarketplaceSource): Promise<MarketplaceManifest | null> {
  const parsed = parseGitHubUrl(source.url)
  if (!parsed) {
    console.error('[Sources] Invalid GitHub URL:', source.url)
    return null
  }

  const { owner, repo } = parsed

  for (const branch of [source.branch, 'main', 'master']) {
    // 1. Prefer a prebuilt index: skills_index.json (array) — the whole catalog in one request.
    const indexManifest = await tryFetchIndexArray(owner, repo, branch)
    if (indexManifest) {
      cacheManifest(source.id, indexManifest)
      return indexManifest
    }

    // 2. Or a marketplace.json manifest (Claude standard).
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/marketplace.json`
    try {
      const res = await fetch(url)
      if (res.ok) {
        const manifest = await res.json() as MarketplaceManifest
        cacheManifest(source.id, manifest)
        return manifest
      }
    } catch (err) {
      console.error(`[Sources] Failed to fetch from ${url}:`, err)
    }
  }

  // 3. Fallback: scan the repository tree for SKILL.md files (small repos without an index).
  console.log(`[Sources] No index found for ${source.name}, scanning tree for SKILL.md files...`)
  return await scanForSkillFiles(source)
}

/**
 * Fetch a prebuilt skills_index.json (array of skill entries) if the repo ships one.
 * Fast path for large catalogs — the entire list arrives in a single request,
 * avoiding any per-skill fetch storm.
 */
async function tryFetchIndexArray(owner: string, repo: string, branch: string): Promise<MarketplaceManifest | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/skills_index.json`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = await res.json()
    if (!Array.isArray(raw)) return null
    const skills: MarketplaceSkillEntry[] = raw
      .filter((e: any) => e && typeof e.path === 'string')
      .map((e: any) => {
        const setupRaw = e.plugin?.setup
        const setup = setupRaw && typeof setupRaw.type === 'string'
          ? {
              type: setupRaw.type,
              summary: typeof setupRaw.summary === 'string' && setupRaw.summary ? setupRaw.summary : undefined,
              docs: typeof setupRaw.docs === 'string' ? setupRaw.docs : null
            }
          : undefined
        return {
          name: e.name || e.id || (e.path.split('/').pop() ?? 'skill'),
          description: e.description || '',
          path: e.path,
          category: typeof e.category === 'string' ? e.category : undefined,
          risk: typeof e.risk === 'string' ? e.risk : undefined,
          source: typeof e.source === 'string' ? e.source : undefined,
          dateAdded: typeof e.date_added === 'string' ? e.date_added : undefined,
          setup
        }
      })
    if (skills.length === 0) return null
    return { version: '1', skills }
  } catch {
    return null
  }
}

function cacheManifest(sourceId: string, manifest: MarketplaceManifest): void {
  try {
    fs.writeFileSync(getCachedManifestPath(sourceId), JSON.stringify(manifest, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Sources] Failed to cache manifest:', err)
  }
}

/**
 * Scan a GitHub repository for SKILL.md files when no marketplace.json exists.
 * This supports repos like anthropics/skills that have a skills/ directory structure.
 */
async function scanForSkillFiles(source: MarketplaceSource): Promise<MarketplaceManifest | null> {
  const parsed = parseGitHubUrl(source.url)
  if (!parsed) return null
  
  const { owner, repo } = parsed
  
  try {
    // Use GitHub API to get the tree
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
    const res = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AIDE-App'
      }
    })
    
    if (!res.ok) {
      console.error(`[Sources] GitHub API error: ${res.status}`)
      return null
    }
    
    const data = await res.json() as { tree: Array<{ path: string; type: string }>; truncated?: boolean }

    if (data.truncated) {
      console.warn(`[Sources] Tree for ${owner}/${repo} is truncated; some skills may be missing. A skills_index.json would give full coverage.`)
    }

    // Find files literally named SKILL.md at any depth (avoids matching e.g. MY-SKILL.md).
    const skillFiles = data.tree
      .filter(item => item.type === 'blob' && /(^|\/)SKILL\.md$/i.test(item.path))
      .map(item => item.path)

    if (skillFiles.length === 0) {
      console.log(`[Sources] No SKILL.md files found in ${owner}/${repo}`)
      return null
    }

    // Guard against per-skill fetch storms: only read each SKILL.md's frontmatter
    // when the count is small. Large catalogs should ship a skills_index.json
    // (handled earlier); here we degrade gracefully to path-derived names.
    const FETCH_DETAIL_LIMIT = 60
    const skills: MarketplaceSkillEntry[] = []

    if (skillFiles.length > FETCH_DETAIL_LIMIT) {
      for (const filePath of skillFiles) {
        const dir = filePath.replace(/(^|\/)SKILL\.md$/i, '')
        skills.push({ name: dir.split('/').pop() || filePath, description: '', path: filePath })
      }
      const manifest: MarketplaceManifest = { version: '1', name: source.name, skills }
      cacheManifest(source.id, manifest)
      console.log(`[Sources] Indexed ${skills.length} skills (names only) from ${owner}/${repo}`)
      return manifest
    }

    for (const filePath of skillFiles) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`
        const fileRes = await fetch(rawUrl)
        if (!fileRes.ok) continue
        
        const content = await fileRes.text()
        
        // Parse frontmatter
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let name = path.basename(path.dirname(filePath))
        let description = ''
        
        if (frontmatterMatch) {
          const yaml = frontmatterMatch[1]
          const nameMatch = yaml.match(/^name:\s*(.+)$/m)
          if (nameMatch) {
            name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
          }
          const descMatch = yaml.match(/^description:\s*(.+)$/m)
          if (descMatch) {
            description = descMatch[1].trim().replace(/^["']|["']$/g, '')
          }
        }
        
        skills.push({
          name,
          description,
          path: filePath
        })
      } catch (err) {
        console.error(`[Sources] Failed to fetch ${filePath}:`, err)
      }
    }
    
    if (skills.length === 0) return null
    
    const manifest: MarketplaceManifest = {
      version: '1',
      name: source.name,
      skills
    }
    
    // Cache the generated manifest
    const cachePath = getCachedManifestPath(source.id)
    fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2), 'utf-8')
    
    console.log(`[Sources] Found ${skills.length} skills in ${owner}/${repo}`)
    return manifest
    
  } catch (err) {
    console.error(`[Sources] Failed to scan ${source.url}:`, err)
    return null
  }
}

/**
 * Get cached manifest for a source.
 */
function getCachedManifest(sourceId: string): MarketplaceManifest | null {
  const cachePath = getCachedManifestPath(sourceId)
  if (!fs.existsSync(cachePath)) return null
  
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Sync a single source - fetch its manifest and update skill count.
 */
export async function syncSource(sourceId: string): Promise<MarketplaceSource> {
  const source = listSources().find(s => s.id === sourceId)
  if (!source) {
    throw new Error('Source not found')
  }

  const manifest = await fetchManifest(source)

  return {
    ...source,
    lastSyncedAt: new Date().toISOString(),
    skillCount: manifest?.skills.length || 0
  }
}

/**
 * Sync all enabled sources.
 */
export async function syncAllSources(): Promise<void> {
  const sources = listSources().filter(s => s.enabled)
  await Promise.all(sources.map(s => syncSource(s.id).catch(console.error)))
}

// ─── Browse Skills ───────────────────────────────────────────────────

/**
 * Sanitize skill name to match directory naming convention.
 */
function sanitizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Browse available skills from marketplace sources.
 * Returns skills that can be installed.
 */
export async function browseSkills(sourceId?: string): Promise<BrowsableSkill[]> {
  const sources = listSources().filter(s => s.enabled)
  const targetSources = sourceId 
    ? sources.filter(s => s.id === sourceId)
    : sources
  
  const installedSkills = listSkills()
  // Match by both raw ID and sanitized name for compatibility
  const installedIds = new Set(installedSkills.map(s => s.id))
  const installedSanitized = new Set(installedSkills.map(s => sanitizeSkillName(s.id)))
  
  const results: BrowsableSkill[] = []
  
  for (const source of targetSources) {
    // Try cached manifest first, then fetch
    let manifest = getCachedManifest(source.id)
    if (!manifest) {
      manifest = await fetchManifest(source)
    }
    
    if (!manifest) continue
    
    for (const entry of manifest.skills) {
      // Check if installed by sanitized name (matches directory name)
      const sanitizedName = sanitizeSkillName(entry.name)
      const isInstalled = installedIds.has(sanitizedName) || installedSanitized.has(sanitizedName)
      
      results.push({
        name: entry.name,
        description: entry.description,
        category: entry.category,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        path: entry.path,
        installed: isInstalled,
        risk: entry.risk,
        source: entry.source,
        dateAdded: entry.dateAdded,
        setup: entry.setup
      })
    }
  }
  
  return results
}

// ─── Install from Marketplace ────────────────────────────────────────

/**
 * Download a single file from GitHub.
 */
async function downloadFile(owner: string, repo: string, branch: string, filePath: string): Promise<string | null> {
  for (const tryBranch of [branch, 'main', 'master']) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${tryBranch}/${filePath}`
    try {
      const res = await fetch(url)
      if (res.ok) {
        return await res.text()
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Download all files in a skill directory from GitHub.
 * For official/community sources, downloads the entire skill folder.
 */
async function downloadSkillDirectory(
  owner: string,
  repo: string,
  branch: string,
  skillDirPath: string,  // e.g., "skills/code-review"
  localDir: string
): Promise<void> {
  // Use GitHub API to list all files in the directory tree
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  
  try {
    const res = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AIDE-App'
      }
    })
    
    if (!res.ok) {
      console.error(`[Sources] GitHub API error when listing tree: ${res.status}`)
      return
    }
    
    const data = await res.json() as { tree: Array<{ path: string; type: string }> }
    
    // Filter files that are within the skill directory
    const skillFiles = data.tree.filter(item => 
      item.type === 'blob' && 
      item.path.startsWith(skillDirPath + '/') 
    )
    
    console.log(`[Sources] Found ${skillFiles.length} files in ${skillDirPath}`)
    
    // Download each file
    for (const file of skillFiles) {
      const relativePath = file.path.slice(skillDirPath.length + 1) // Remove prefix
      const localFilePath = path.join(localDir, relativePath)
      
      // Create subdirectory if needed
      const localFileDir = path.dirname(localFilePath)
      if (!fs.existsSync(localFileDir)) {
        fs.mkdirSync(localFileDir, { recursive: true })
      }
      
      // Download and save file
      const content = await downloadFile(owner, repo, branch, file.path)
      if (content !== null) {
        fs.writeFileSync(localFilePath, content, 'utf-8')
        console.log(`[Sources] Downloaded: ${relativePath}`)
      }
    }
  } catch (err) {
    console.error(`[Sources] Failed to download skill directory:`, err)
  }
}

/**
 * Download and install a skill from a marketplace source.
 * Uses the skill name from SKILL.md as the directory name for SDK compatibility.
 */
export async function installFromMarketplace(
  sourceId: string,
  skillPath: string  // e.g., "skills/code-review" or "skills/code-review/SKILL.md"
): Promise<Skill> {
  const source = getSource(sourceId)
  if (!source) {
    throw new Error('Source not found')
  }
  
  const parsed = parseGitHubUrl(source.url)
  if (!parsed) {
    throw new Error('Invalid source URL')
  }
  
  const { owner, repo } = parsed
  
  // Normalize path: if it's a directory, append /SKILL.md
  const skillMdPath = skillPath.toLowerCase().endsWith('skill.md') 
    ? skillPath 
    : `${skillPath}/SKILL.md`
  
  // Get skill directory path (parent of SKILL.md) - ensure forward slashes for GitHub API
  const skillDirPath = skillMdPath.replace(/\\/g, '/').replace(/\/SKILL\.md$/i, '')
  const fallbackName = skillDirPath.split('/').pop() || 'skill'
  
  // First, fetch SKILL.md to get the actual skill name
  const skillContent = await downloadFile(owner, repo, source.branch, skillMdPath)
  if (!skillContent) {
    throw new Error(`Could not download skill from ${skillMdPath}`)
  }
  
  // Parse frontmatter for skill name
  const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  let skillName = fallbackName
  let parsedDescription = ''
  
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1]
    const nameMatch = yaml.match(/^name:\s*(.+)$/m)
    if (nameMatch) {
      skillName = nameMatch[1].trim().replace(/^["']|["']$/g, '')
    }
    const descMatch = yaml.match(/^description:\s*(.+)$/m)
    if (descMatch) {
      parsedDescription = descMatch[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  
  // Sanitize skill name for directory
  const safeName = skillName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  
  // Create local skill directory using skill name (for SDK compatibility)
  const skillsDir = getSkillsDirectory()
  const skillDir = path.join(skillsDir, safeName)
  
  // Remember whether a prior install was disabled so a reinstall keeps that state.
  const wasDisabled = fs.existsSync(path.join(skillDir, 'SKILL.md.disabled')) &&
    !fs.existsSync(path.join(skillDir, 'SKILL.md'))
  
  // Remove existing if any
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true })
  }
  
  // Create directory
  fs.mkdirSync(skillDir, { recursive: true })
  
  // Download entire skill directory
  await downloadSkillDirectory(owner, repo, source.branch, skillDirPath, skillDir)
  
  // Ensure SKILL.md exists
  const localSkillMdPath = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(localSkillMdPath)) {
    fs.writeFileSync(localSkillMdPath, skillContent, 'utf-8')
  }
  
  // Save source metadata for tracking
  const sourceMetadata = {
    sourceType: source.type,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    owner,
    repo,
    branch: source.branch,
    originalPath: skillPath,
    installedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(skillDir, '.source.json'), JSON.stringify(sourceMetadata, null, 2), 'utf-8')
  
  // Restore the disabled state if the skill was disabled before reinstall.
  if (wasDisabled) {
    fs.renameSync(localSkillMdPath, path.join(skillDir, 'SKILL.md.disabled'))
  }
  
  const stat = fs.statSync(wasDisabled ? path.join(skillDir, 'SKILL.md.disabled') : localSkillMdPath)
  
  // Count files in directory
  const countFiles = (dir: string): number => {
    let count = 0
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.isFile() && !item.name.startsWith('.')) count++
      else if (item.isDirectory()) count += countFiles(path.join(dir, item.name))
    }
    return count
  }
  const fileCount = countFiles(skillDir)
  console.log(`[Sources] Installed skill "${skillName}" with ${fileCount} file(s)`)
  
  return {
    id: safeName,
    name: skillName,
    description: parsedDescription,
    source: 'marketplace',
    sourceId: source.id,
    sourceUrl: `${source.url}/blob/${source.branch}/${skillPath}`,
    verified: source.type === 'official' || source.type === 'community',
    enabled: !wasDisabled,
    path: skillDir,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString()
  }
}
