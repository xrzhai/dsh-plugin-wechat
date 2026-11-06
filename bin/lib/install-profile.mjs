import fs from 'node:fs'
import path from 'node:path'

export const PKG_NAME = 'dsh-plugin-wechat'
/** Turn an absolute source checkout into a portable pnpm link spec. */
export function sourceLinkSpec(sourceRoot) {
  return 'link:' + path.resolve(sourceRoot).replaceAll('\\', '/')
}

/** Same lexical path, using the platform's case rules on Windows. */
export function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Remove a profile's package entry without following a link back to the source
 * checkout. A symlink or junction is unlinked; only a real copied directory is
 * recursively removed.
 */
export function removeInstalledPackage(targetDir, sourceRoot, { allowSelf = false } = {}) {
  const stat = fs.lstatSync(targetDir, { throwIfNoEntry: false })
  if (stat === undefined) return { removed: false, reason: 'missing' }
  if (!allowSelf && samePath(targetDir, sourceRoot)) {
    return { removed: false, reason: 'source-is-target' }
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetDir)
    return { removed: true, reason: 'link' }
  }
  const realTarget = fs.realpathSync.native ? fs.realpathSync.native(targetDir) : fs.realpathSync(targetDir)
  const realSource = fs.existsSync(sourceRoot)
    ? (fs.realpathSync.native ? fs.realpathSync.native(sourceRoot) : fs.realpathSync(sourceRoot))
    : path.resolve(sourceRoot)
  if (samePath(realTarget, realSource) || (!allowSelf && isInside(realTarget, realSource))) {
    return { removed: false, reason: 'contains-source' }
  }
  fs.rmSync(targetDir, { recursive: true, force: true })
  return { removed: true, reason: 'copy' }
}
