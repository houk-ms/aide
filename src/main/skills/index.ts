/**
 * Skills module - manages user-defined and downloaded skills.
 * Skills are stored in .aide/skills/ directory as SKILL.md files.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import type { Skill } from '@shared/types'

// ─── Directory Management ────────────────────────────────────────────

/**
 * Get the skills directory path (~/.aide/skills/ in user home).
 * Creates the directory if it doesn't exist.
 * Uses os.homedir() for stable path across different launch methods.
 */
export function getSkillsDirectory(): string {
  const skillsDir = path.join(os.homedir(), '.aide', 'skills')
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }
  return skillsDir
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────

interface SkillFrontmatter {
  name?: string
  description?: string
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Expects format:
 * ---
 * name: skill-name
 * description: "Description"
 * ---
 * # Content
 */
function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: SkillFrontmatter = {}

  // Simple YAML parsing for name and description
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  if (nameMatch) {
    result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  if (descMatch) {
    result.description = descMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  return result
}

// ─── Skill CRUD ──────────────────────────────────────────────────────

/**
 * List all skills in the skills directory.
 * Scans subdirectories for SKILL.md files and parses their frontmatter.
 * Source information is read from .source.json if present.
 */
export function listSkills(): Skill[] {
  const skillsDir = getSkillsDirectory()
  const skills: Skill[] = []

  if (!fs.existsSync(skillsDir)) return skills

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillDir = path.join(skillsDir, entry.name)
    const skillFile = path.join(skillDir, 'SKILL.md')
    const disabledFile = path.join(skillDir, 'SKILL.md.disabled')
    const sourceFile = path.join(skillDir, '.source.json')

    // Check for enabled or disabled skill file
    const isDisabled = !fs.existsSync(skillFile) && fs.existsSync(disabledFile)
    const activeFile = isDisabled ? disabledFile : skillFile

    if (!fs.existsSync(activeFile)) continue

    try {
      const content = fs.readFileSync(activeFile, 'utf-8')
      const frontmatter = parseFrontmatter(content)
      const stat = fs.statSync(activeFile)

      // Read source metadata (.source.json) written at install time
      let source: 'local' | 'marketplace' = 'local'
      let sourceId: string | undefined
      let sourceUrl: string | null = null
      let verified = false

      if (fs.existsSync(sourceFile)) {
        try {
          const sourceData = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'))
          source = sourceData.sourceType && sourceData.sourceType !== 'local' ? 'marketplace' : 'local'
          sourceId = sourceData.sourceId
          sourceUrl = sourceData.sourceUrl || (sourceData.owner && sourceData.repo
            ? `https://github.com/${sourceData.owner}/${sourceData.repo}`
            : null)
          verified = sourceData.sourceType === 'official' || sourceData.sourceType === 'community'
        } catch {
          // Ignore parse errors
        }
      }

      skills.push({
        id: entry.name,
        name: frontmatter.name || entry.name,
        description: frontmatter.description || '',
        source,
        sourceId,
        sourceUrl,
        verified,
        enabled: !isDisabled,
        path: skillDir,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString()
      })
    } catch (err) {
      console.error(`[Skills] Failed to read skill ${entry.name}:`, err)
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Get a single skill by ID.
 */
export function getSkill(id: string): Skill | null {
  const skills = listSkills()
  return skills.find(s => s.id === id) || null
}

/**
 * Toggle skill enabled/disabled state.
 * Implemented by renaming SKILL.md ↔ SKILL.md.disabled
 */
export function toggleSkill(id: string, enabled: boolean): Skill {
  const skillsDir = getSkillsDirectory()
  const skillDir = path.join(skillsDir, id)
  const skillFile = path.join(skillDir, 'SKILL.md')
  const disabledFile = path.join(skillDir, 'SKILL.md.disabled')

  if (enabled) {
    // Enable: rename .disabled to normal
    if (fs.existsSync(disabledFile)) {
      fs.renameSync(disabledFile, skillFile)
    }
  } else {
    // Disable: rename normal to .disabled
    if (fs.existsSync(skillFile)) {
      fs.renameSync(skillFile, disabledFile)
    }
  }

  return getSkill(id)!
}

/**
 * Delete a skill and its directory.
 */
export function deleteSkill(id: string): void {
  const skillsDir = getSkillsDirectory()
  const skillDir = path.join(skillsDir, id)

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true })
  }
}

// ─── Local Path Install ──────────────────────────────────────────────

/**
 * Install a skill from a local folder on disk.
 * Accepts either a skill folder (containing SKILL.md) or a SKILL.md path directly.
 * Copies the whole folder into the skills directory so the agent can use it.
 * Used by the agent's install_skill tool for local installs.
 */
export function installSkillFromLocalPath(folderPath: string): Skill {
  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error(`Path does not exist: ${folderPath}`)
  }

  const stat = fs.statSync(folderPath)

  // Resolve the directory that holds SKILL.md
  let skillSrcDir: string
  if (stat.isDirectory()) {
    skillSrcDir = folderPath
  } else if (/(^|[\\/])SKILL\.md$/i.test(folderPath)) {
    skillSrcDir = path.dirname(folderPath)
  } else {
    throw new Error('Path must be a skill folder or a SKILL.md file')
  }

  const skillMdPath = path.join(skillSrcDir, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found in ${skillSrcDir}`)
  }

  // Determine skill name from frontmatter, fall back to the folder name
  const content = fs.readFileSync(skillMdPath, 'utf-8')
  const fm = parseFrontmatter(content)
  const rawName = fm.name || path.basename(skillSrcDir)
  const safeName = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `skill-${uuid().slice(0, 8)}`

  const skillsDir = getSkillsDirectory()
  const destDir = path.join(skillsDir, safeName)

  // Remember whether a prior install was disabled so a reinstall keeps that state,
  // then overwrite (consistent with marketplace reinstall behaviour).
  const wasDisabled = fs.existsSync(path.join(destDir, 'SKILL.md.disabled')) &&
    !fs.existsSync(path.join(destDir, 'SKILL.md'))
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true })
  }

  // Copy the entire folder recursively
  fs.cpSync(skillSrcDir, destDir, { recursive: true })

  // Record source metadata
  fs.writeFileSync(
    path.join(destDir, '.source.json'),
    JSON.stringify({ sourceType: 'local', originalPath: skillSrcDir, installedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  )

  // Restore the disabled state if the skill was disabled before reinstall.
  if (wasDisabled) {
    const enabledFile = path.join(destDir, 'SKILL.md')
    if (fs.existsSync(enabledFile)) {
      fs.renameSync(enabledFile, path.join(destDir, 'SKILL.md.disabled'))
    }
  }

  console.log(`[Skills] Installed local skill "${safeName}" from ${skillSrcDir}`)
  return getSkill(safeName)!
}
