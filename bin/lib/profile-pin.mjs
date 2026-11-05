/**
 * Pin a DSH profile to the installed plugin.
 *
 * Release installs use a published caret range. Source installs use a pnpm
 * link spec pointing at the checkout that contains this script. The latter is
 * the path a fresh clone needs because the renamed package may not exist on
 * npm at all.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { sourceLinkSpec } from './install-profile.mjs'

export const PKG_NAME = 'dsh-plugin-wechat'

/** The pnpm the app itself uses, so the lockfile matches what the app resolves. */
export const BUNDLED_PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'

// Node cannot spawn npm's Windows .cmd/.ps1 shims directly. Resolve their
// adjacent executable or JS entry instead, without passing paths to a shell.
export function pnpmCommand({ env = process.env, platform = process.platform, nodePath = process.execPath } = {}) {
    if (platform !== 'win32' && fs.existsSync(BUNDLED_PNPM)) return { command: nodePath, prefix: [BUNDLED_PNPM] }
    if (platform === 'win32') {
        const searchPath = env.PATH ?? env.Path ?? ''
        for (const entry of searchPath.split(';')) {
            const dir = entry.replace(/^"|"$/g, '')
            if (!dir) continue
            for (const relative of ['pnpm.exe', 'node_modules/pnpm/pnpm.exe', 'node_modules/pnpm/bin/pnpm.mjs', 'node_modules/pnpm/bin/pnpm.cjs']) {
                const candidate = path.join(dir, relative)
                if (!fs.existsSync(candidate)) continue
                return candidate.endsWith('.exe')
                    ? { command: candidate, prefix: [] }
                    : { command: nodePath, prefix: [candidate] }
            }
        }
    }
    return { command: 'pnpm', prefix: [] }
}

/**
 * Rewrite an existing published caret range, or add the dependency when the
 * old package name left the profile without a current one.
 *
 * Existing caret specs are edited textually so release installs do not reformat
 * the whole profile package.json. Missing dependencies necessarily use JSON
 * serialization because there is no property location to patch safely.
 */
export function pinProfileSpec(raw, nextVersion) {
    let pkg
    try {
        pkg = JSON.parse(raw)
    } catch {
        return null
    }
    const declared = pkg?.dependencies?.[PKG_NAME]
    const wanted = '^' + nextVersion
    if (declared === undefined) {
        pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object'
            ? pkg.dependencies
            : {}
        pkg.dependencies[PKG_NAME] = wanted
        return { from: undefined, to: wanted, text: JSON.stringify(pkg, null, 2) + '\n' }
    }
    if (typeof declared !== 'string' || !declared.startsWith('^')) return null
    if (declared === wanted) return null
    const escapedName = PKG_NAME.replace(/[.*+?^$()|[\]{}]/g, '\\$&')
    const pattern = new RegExp('("' + escapedName + '"\\s*:\\s*)"\\^[^"]*"')
    if (!pattern.test(raw)) return null
    return { from: declared, to: wanted, text: raw.replace(pattern, '$1"' + wanted + '"') }
}

/**
 * Persist a source checkout in the profile's dependency graph. Local source
 * installs deliberately use pnpm's link protocol: they do not require this
 * package to have been published, and a restart re-resolves this checkout.
 */
export function pinProfileSourceSpec(raw, sourceRoot) {
    let pkg
    try {
        pkg = JSON.parse(raw)
    } catch {
        return null
    }
    const wanted = sourceLinkSpec(sourceRoot)
    const declared = pkg?.dependencies?.[PKG_NAME]
    if (declared === wanted) return null
    pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object'
        ? pkg.dependencies
        : {}
    pkg.dependencies[PKG_NAME] = wanted
    return { from: declared, to: wanted, text: JSON.stringify(pkg, null, 2) + '\n' }
}

function sameLexicalPath(left, right) {
    const a = path.resolve(left)
    const b = path.resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Pin a profile and refresh its lockfile.
 *
 * @param {object} options
 * @param {string} options.profile profile name
 * @param {string} [options.version] published version to pin
 * @param {string} [options.sourceRoot] checkout to link for a source install
 * @param {(line: string) => void} [options.ok]
 * @param {(line: string) => void} [options.warn]
 * @param {(line: string) => void} [options.note]
 * @param {string} [options.dshHome] override for tests
 * @param {typeof spawnSync} [options.spawn] override for tests
 * @param {string} [options.nodePath] node binary used to run bundled pnpm
 * @returns {{pinned: boolean, reason?: string}}
 */
export function pinProfileDependency({
    profile,
    version,
    sourceRoot,
    ok = () => {},
    warn = () => {},
    note = () => {},
    dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    spawn = spawnSync,
    nodePath = process.execPath,
} = {}) {
    const profileDir = path.join(dshHome, 'profiles', profile)
    const pkgPath = path.join(profileDir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
        warn('no ' + pkgPath + ' - the profile cannot be pinned, only copied')
        return { pinned: false, reason: 'no-profile-package' }
    }
    if (sourceRoot !== undefined) {
        const targetDir = path.join(profileDir, 'node_modules', PKG_NAME)
        if (sameLexicalPath(sourceRoot, targetDir)) {
            warn('refusing to link ' + PKG_NAME + ' to the profile copy at ' + targetDir)
            return { pinned: false, reason: 'source-is-target' }
        }
    }
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const patch = sourceRoot === undefined
        ? pinProfileSpec(raw, version)
        : pinProfileSourceSpec(raw, sourceRoot)
    if (patch === null) {
        ok(sourceRoot === undefined
            ? 'profile dependency already points at this version (or is pinned by hand)'
            : 'profile dependency already points at this source checkout')
        if (sourceRoot === undefined) return { pinned: false, reason: 'already-pinned' }
    } else {
        fs.writeFileSync(pkgPath, patch.text)
        ok('profile dependency ' + String(patch.from ?? 'missing') + ' -> ' + patch.to)
    }
    const args = sourceRoot === undefined
        ? ['install', '--prefer-offline']
        : ['install', '--offline']
    const cwd = path.dirname(pkgPath)
    const runner = pnpmCommand({ nodePath })
    const refreshed = spawn(runner.command, [...runner.prefix, ...args], { cwd, encoding: 'utf8' })
    if (refreshed.status !== 0) {
        warn('could not refresh the profile lockfile - run pnpm install in the profile by hand')
        note(String(refreshed.error?.message ?? refreshed.stderr ?? '').trim().split('\n').slice(-2).join('\n'))
        return { pinned: true, reason: 'lock-not-refreshed' }
    }
    ok(sourceRoot === undefined
        ? 'profile lockfile refreshed; the app will not roll back on restart'
        : 'profile lockfile refreshed from local source; restart-safe and offline')
    return { pinned: true }
}
