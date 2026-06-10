#!/usr/bin/env node
// Downloads the sentence-embedding model used for local semantic memory search
// (Xenova/all-MiniLM-L6-v2) into ./models so electron-builder can bundle it
// offline via extraResources. Without a bundled copy the app would try to fetch
// the weights from the Hugging Face Hub at runtime into a directory inside the
// read-only app.asar — which fails in packaged builds. Idempotent: files that
// already exist are skipped unless --force is passed.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const HOST = process.env.AIDE_MODEL_HOST || 'https://huggingface.co'

// transformers.js (feature-extraction, quantized) loads exactly these files.
const FILES = [
  { path: 'config.json', required: true },
  { path: 'tokenizer.json', required: true },
  { path: 'tokenizer_config.json', required: true },
  { path: 'special_tokens_map.json', required: false },
  { path: 'onnx/model_quantized.onnx', required: true },
]

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(projectRoot, 'models', MODEL_ID)
const force = process.argv.includes('--force')

function download(url, dest, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const req = https.get(url, { headers: { 'User-Agent': 'aide-fetch-model' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy()
        const next = new URL(res.headers.location, url).toString()
        resolvePromise(download(next, dest, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.destroy()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      mkdirSync(dirname(dest), { recursive: true })
      const tmp = `${dest}.part`
      const file = createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => file.close(() => {
        try {
          renameSync(tmp, dest)
          resolvePromise()
        } catch (err) {
          reject(err)
        }
      }))
      file.on('error', err => {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        reject(err)
      })
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout')))
  })
}

let failed = false
for (const f of FILES) {
  const dest = join(outRoot, f.path)
  if (!force && existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[fetch-model] skip ${f.path} (already present)`)
    continue
  }
  const url = `${HOST}/${MODEL_ID}/resolve/main/${f.path}`
  try {
    console.log(`[fetch-model] downloading ${f.path} ...`)
    await download(url, dest)
    console.log(`[fetch-model]   -> ${(statSync(dest).size / 1048576).toFixed(2)} MB`)
  } catch (err) {
    if (f.required) {
      console.error(`[fetch-model] FAILED (required) ${f.path}: ${err.message}`)
      failed = true
    } else {
      console.warn(`[fetch-model] optional ${f.path} skipped: ${err.message}`)
    }
  }
}

if (failed) {
  console.error('[fetch-model] one or more required files failed to download')
  process.exit(1)
}
console.log(`[fetch-model] done -> ${outRoot}`)
