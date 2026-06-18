#!/usr/bin/env node
// ============================================================
// Fetch portable Node.js runtimes for each platform
// Run: node scripts/fetch-runtimes.mjs
// Downloads to: runtimes/node-{platform}-{arch}/
// ============================================================

import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, chmodSync } from 'fs'
import { pipeline } from 'stream/promises'
import { createGunzip } from 'zlib'
import { extract } from 'tar'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIMES_DIR = join(ROOT, 'runtimes')

// Node.js LTS version to bundle
const NODE_VERSION = '20.18.0'

// Map process.platform to electron-builder's ${os} naming
const OS_MAP = {
  'darwin': 'mac',
  'win32': 'win',
  'linux': 'linux'
}

// Platform configs: { os-arch: { url, extractDir, binPath } }
// Uses electron-builder's ${os} naming convention: mac, linux, win
const PLATFORMS = {
  'win-x64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
    extractDir: `node-v${NODE_VERSION}-win-x64`,
    binPath: 'npx.cmd'
  },
  'mac-x64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    extractDir: `node-v${NODE_VERSION}-darwin-x64`,
    binPath: 'bin/npx'
  },
  'mac-arm64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    extractDir: `node-v${NODE_VERSION}-darwin-arm64`,
    binPath: 'bin/npx'
  },
  'linux-x64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
    extractDir: `node-v${NODE_VERSION}-linux-x64`,
    binPath: 'bin/npx'
  }
}

async function downloadFile(url, dest) {
  console.log(`  Downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function extractTarGz(archive, destDir) {
  console.log(`  Extracting ${archive}`)
  await pipeline(
    createReadStream(archive),
    createGunzip(),
    extract({ cwd: destDir })
  )
}

async function extractZip(archive, destDir) {
  console.log(`  Extracting ${archive}`)
  // Use PowerShell on Windows, unzip elsewhere
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`)
  } else {
    execSync(`unzip -q -o "${archive}" -d "${destDir}"`)
  }
}

import { createReadStream } from 'fs'

async function fetchPlatform(platformKey) {
  const config = PLATFORMS[platformKey]
  if (!config) {
    console.log(`  Skipping unknown platform: ${platformKey}`)
    return
  }

  const destDir = join(RUNTIMES_DIR, `node-${platformKey}`)
  const npxPath = join(destDir, config.binPath)

  // Skip if already downloaded
  if (existsSync(npxPath)) {
    console.log(`  ✓ ${platformKey} already exists`)
    return
  }

  console.log(`  Fetching Node.js for ${platformKey}...`)

  // Create temp dir for download
  const tempDir = join(RUNTIMES_DIR, '.tmp')
  mkdirSync(tempDir, { recursive: true })

  const isZip = config.url.endsWith('.zip')
  const archivePath = join(tempDir, `node-${platformKey}${isZip ? '.zip' : '.tar.gz'}`)

  try {
    await downloadFile(config.url, archivePath)

    if (isZip) {
      await extractZip(archivePath, tempDir)
    } else {
      await extractTarGz(archivePath, tempDir)
    }

    // Move extracted dir to final location
    const extractedDir = join(tempDir, config.extractDir)
    if (existsSync(destDir)) rmSync(destDir, { recursive: true })
    renameSync(extractedDir, destDir)

    // Make binaries executable on Unix
    if (!platformKey.startsWith('win-')) {
      chmodSync(join(destDir, 'bin/node'), 0o755)
      chmodSync(join(destDir, 'bin/npm'), 0o755)
      chmodSync(join(destDir, 'bin/npx'), 0o755)
    }

    console.log(`  ✓ ${platformKey} ready`)
  } finally {
    // Cleanup temp files
    if (existsSync(archivePath)) rmSync(archivePath)
  }
}

async function main() {
  console.log(`\nFetching Node.js v${NODE_VERSION} runtimes...\n`)

  mkdirSync(RUNTIMES_DIR, { recursive: true })

  // Map process.platform to electron-builder's ${os} naming
  const osName = OS_MAP[process.platform] || process.platform
  const targetPlatform = process.env.BUILD_PLATFORM || `${osName}-${process.arch}`

  // In CI, runtimes are downloaded separately per platform. Locally, fetch current platform only.
  const platformsToFetch = process.env.CI
    ? [targetPlatform]
    : [targetPlatform]

  for (const platform of platformsToFetch) {
    await fetchPlatform(platform)
  }

  // Cleanup temp dir
  const tempDir = join(RUNTIMES_DIR, '.tmp')
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true })

  console.log('\nDone!\n')
}

main().catch(err => {
  console.error('Failed to fetch runtimes:', err)
  process.exit(1)
})
