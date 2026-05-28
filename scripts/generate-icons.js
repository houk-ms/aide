const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const svg = fs.readFileSync(path.join(__dirname, '..', 'resources/icon.svg'))
const sizes = [16, 32, 48, 64, 128, 256, 512]

async function generate() {
  for (const size of sizes) {
    await sharp(svg).resize(size, size).png().toFile(path.join(__dirname, '..', 'resources', `icon-${size}.png`))
    console.log(`  icon-${size}.png`)
  }
  await sharp(svg).resize(256, 256).png().toFile(path.join(__dirname, '..', 'resources', 'icon.png'))
  console.log('  icon.png (256px)')
  console.log('Done!')
}

generate().catch(console.error)
