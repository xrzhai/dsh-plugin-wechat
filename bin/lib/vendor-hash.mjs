import fs from 'node:fs'
import crypto from 'node:crypto'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export function isBinary(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('expected a Buffer')
  if (buffer.includes(0)) return true
  try {
    UTF8_DECODER.decode(buffer)
    return false
  } catch {
    return true
  }
}

export function canonicalizeVendorBytes(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('expected a Buffer')
  if (isBinary(buffer)) return buffer

  let crlfCount = 0
  for (let index = 0; index < buffer.length - 1; index++) {
    if (buffer[index] === 0x0d && buffer[index + 1] === 0x0a) crlfCount++
  }
  if (crlfCount === 0) return buffer

  const normalized = Buffer.allocUnsafe(buffer.length - crlfCount)
  let target = 0
  for (let source = 0; source < buffer.length; source++) {
    if (buffer[source] === 0x0d && buffer[source + 1] === 0x0a) continue
    normalized[target++] = buffer[source]
  }
  return normalized
}

export function hashVendorBytes(buffer) {
  return crypto.createHash('sha256').update(canonicalizeVendorBytes(buffer)).digest('hex')
}

export function hashVendorFile(file) {
  return hashVendorBytes(fs.readFileSync(file))
}
