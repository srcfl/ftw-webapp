/* Generates the PNG icons from public/icons/icon.svg.
 *
 * A manifest that lists PNGs it does not have is a manifest no browser will
 * offer to install, so these have to exist — and no rasteriser is in the
 * dependency tree. Adding one (sharp, resvg) pulls a platform-specific native
 * binary into every install of a project that needs this once per icon change,
 * so instead: the placeholder mark is a rounded rectangle and a six-point
 * polygon, and that is a page of code to draw exactly.
 *
 * It reads the SVG rather than restating it, so the mark stays defined in one
 * place. That does mean it only understands the subset that mark uses:
 * straight-line path commands and a solid fill. When the real icon arrives it
 * will almost certainly need curves, and the honest move then is to delete
 * this and export the PNGs from the design file.
 *
 *   node scripts/make-icons.mjs
 *
 * Output is committed. Nothing in the build runs it.
 */

import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ICONS = new URL('../public/icons/', import.meta.url)

/* Bleed means the mark fills the square and the platform rounds it.
 * iOS applies its own corner radius to apple-touch-icon and ignores
 * transparency; a maskable icon is cropped to a circle by Android. Both would
 * show a dark ring around our own rounded corners if we kept them. */
const OUTPUTS = [
  { file: 'icon-192.png', size: 192, bleed: false },
  { file: 'icon-512.png', size: 512, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, bleed: true },
]

/** Supersampling factor per axis. 4 is 16 samples a pixel — enough that a
 *  diagonal edge on a 180px icon reads as clean at arm's length. */
const SS = 4

function main() {
  const svg = readFileSync(new URL('icon.svg', ICONS), 'utf8')
  const mark = parseMark(svg)

  for (const { file, size, bleed } of OUTPUTS) {
    const path = fileURLToPath(new URL(file, ICONS))
    writeFileSync(path, encodePng(size, size, render(mark, size, bleed)))
    console.log(`${file}  ${size}x${size}`)
  }
}

// ---------------------------------------------------------------- the SVG

/** Pulls the viewBox, the background rect and the single filled path. */
function parseMark(svg) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  const rect = /<rect[^>]*rx="(\d+)"[^>]*fill="([^"]+)"/.exec(svg)
  const path = /<path[\s\S]*?d="([^"]+)"[\s\S]*?fill="\s*([^"]+?)\s*"/.exec(svg)
  if (!viewBox || !rect || !path) throw new Error('icon.svg is not the shape this script understands')

  return {
    box: Number(viewBox[1]),
    radius: Number(rect[1]),
    background: parseColor(rect[2]),
    foreground: parseColor(path[2]),
    polygon: parsePolygon(path[1]),
  }
}

/** The straight-line subset of the path grammar: M, L, H, V and Z, absolute
 *  or relative, with the repeat rule that a bare coordinate pair continues
 *  the previous command. */
function parsePolygon(d) {
  const tokens = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+/g) ?? []
  const points = []
  let command = 'M'
  let x = 0
  let y = 0
  let i = 0

  const take = () => Number(tokens[i++])

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      command = tokens[i++]
      // An implicit repeat of moveto is lineto, per the SVG grammar.
      if (command === 'Z' || command === 'z') break
    }

    const relative = command === command.toLowerCase()
    if (command === 'H' || command === 'h') x = relative ? x + take() : take()
    else if (command === 'V' || command === 'v') y = relative ? y + take() : take()
    else {
      const dx = take()
      const dy = take()
      x = relative ? x + dx : dx
      y = relative ? y + dy : dy
    }

    points.push([x, y])
    if (command === 'M') command = 'L'
    else if (command === 'm') command = 'l'
  }

  return points
}

// -------------------------------------------------------------- the pixels

function render({ box, radius, background, foreground, polygon }, size, bleed) {
  const pixels = new Uint8Array(size * size * 4)
  const scale = box / size
  const step = 1 / SS

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied accumulation: only the corners are transparent, and
      // averaging them unpremultiplied would fringe them with black.
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px + (sx + 0.5) * step) * scale
          const uy = (py + (sy + 0.5) * step) * scale

          let colour = null
          if (inPolygon(ux, uy, polygon)) colour = foreground
          else if (bleed || inRoundedRect(ux, uy, box, radius)) colour = background
          if (!colour) continue

          r += colour[0]
          g += colour[1]
          b += colour[2]
          a += 255
        }
      }

      const samples = SS * SS
      const o = (py * size + px) * 4
      const alpha = a / samples
      pixels[o] = alpha === 0 ? 0 : Math.round(r / samples / (alpha / 255))
      pixels[o + 1] = alpha === 0 ? 0 : Math.round(g / samples / (alpha / 255))
      pixels[o + 2] = alpha === 0 ? 0 : Math.round(b / samples / (alpha / 255))
      pixels[o + 3] = Math.round(alpha)
    }
  }

  return pixels
}

function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inRoundedRect(x, y, box, radius) {
  // Distance to the nearest corner centre, clamped so the straight edges and
  // the middle answer trivially.
  const dx = Math.max(radius - x, x - (box - radius), 0)
  const dy = Math.max(radius - y, y - (box - radius), 0)
  return dx * dx + dy * dy <= radius * radius
}

// -------------------------------------------------------------- the colours

function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim())
  if (oklch) return oklchToSrgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]))

  throw new Error(`unsupported colour: ${value}`)
}

/** Oklab to linear sRGB, then the sRGB transfer function. The palette is
 *  authored in oklch and PNG has no colour model but sRGB. */
function oklchToSrgb(lightness, chroma, hue) {
  const rad = (hue * Math.PI) / 180
  const a = chroma * Math.cos(rad)
  const b = chroma * Math.sin(rad)

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((linear) => {
    const c = Math.min(Math.max(linear, 0), 1)
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(encoded * 255)
  })
}

// ------------------------------------------------------------------ the PNG

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter type 0. These are flat colours; a predictor would buy little and
    // cost the only interesting code in this function.
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

main()
