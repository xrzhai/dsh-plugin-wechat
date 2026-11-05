#!/usr/bin/env node
/**
 * How much of the chat-facing text is still not in the catalogue (C33).
 *
 * Default mode is a report; check.mjs applies the checked-in per-file baseline.
 * This counts literal/template fragments, not untranslated messages: the catalogue covers command help and the
 * notices the bot sends on its own, and the rest of the strings live inside
 * large functions where a key would be more indirection than it is worth. The
 * number is here so the debt is visible and shrinking, and so nobody has to
 * guess how much is left.
 *
 * `--fail-over <n>` turns it into a gate once a team decides the number.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'espree'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = ['src', 'bin']
const CJK = /[\u4e00-\u9fff]/
// Count actual CJK string/template fragments, not comments or arbitrary text.
// Counting fragments also catches a second message added on an existing line.
export function countCjkStrings(source, { catalogue = false } = {}) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    let count = 0
    function visit(node) {
        if (!node || typeof node !== 'object') return
        if (catalogue && node.type === 'VariableDeclarator' && node.id?.name === 'CATALOG') return
        if (node.type === 'ImportDeclaration') return
        if (node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value)) count++
        if (node.type === 'TemplateElement' && CJK.test(node.value.raw)) count++
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit)
            else if (value && typeof value === 'object') visit(value)
        }
    }
    visit(ast)
    return count
}

/** Every .js file under the source directories. */
function walk(dir) {
    const found = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stats = statSync(full)
        if (stats.isDirectory()) {
            if (entry === 'node_modules' || entry === 'vendor' || entry.startsWith('.')) continue
            found.push(...walk(full))
        } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
            found.push(full)
        }
    }
    return found
}

export function report(root = ROOT) {
const rows = []
for (const sourceDir of SOURCES) {
    for (const file of walk(join(root, sourceDir))) {
        const name = relative(root, file).replaceAll('\\', '/')
        const count = countCjkStrings(readFileSync(file, 'utf8'), { catalogue: name === 'src/i18n.js' })
        if (count > 0) rows.push({ file: name, count })
    }
}
rows.sort((left, right) => right.count - left.count || left.file.localeCompare(right.file))
return { rows, total: rows.reduce((sum, row) => sum + row.count, 0) }
}

export function baselineProblems(result, baseline) {
    if (!baseline || baseline.version !== 1 || !baseline.files || typeof baseline.files !== 'object' ||
        Array.isArray(baseline.files) || Object.values(baseline.files).some(n => !Number.isSafeInteger(n) || n < 0)) {
        throw new Error('invalid i18n baseline')
    }
    const growth = result.rows.filter(row => row.count > (baseline.files[row.file] ?? 0))
        .map(row => `${row.file}: ${row.count} > ${baseline.files[row.file] ?? 0}`)
    const counts = Object.fromEntries(result.rows.map(row => [row.file, row.count]))
    const reductions = Object.entries(baseline.files).filter(([file, count]) => (counts[file] ?? 0) < count)
        .map(([file, count]) => `${file}: lower baseline from ${count} to ${counts[file] ?? 0}`)
    return [...growth, ...reductions]
}

export function run(args = process.argv.slice(2)) {
    let failOver
    let baselinePath
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--fail-over' || arg.startsWith('--fail-over=')) {
            const value = arg === '--fail-over' ? args[++i] : arg.slice('--fail-over='.length)
            if (!/^\d+$/.test(value ?? '')) throw new Error('--fail-over requires a nonnegative integer')
            failOver = Number(value)
            if (!Number.isSafeInteger(failOver)) throw new Error('invalid --fail-over')
        } else if (arg === '--baseline') {
            baselinePath = args[++i]
            if (!baselinePath || baselinePath.startsWith('-')) throw new Error('--baseline requires a file')
        } else throw new Error('unknown option: ' + arg)
    }
    const result = report()
    console.log(`CJK string fragments outside the catalogue: ${result.total}`)
    for (const row of result.rows.slice(0, 15)) console.log(`  ${String(row.count).padStart(4)}  ${row.file}`)
    const problems = baselinePath ? baselineProblems(result, JSON.parse(readFileSync(baselinePath, 'utf8'))) : []
    if (failOver !== undefined && result.total > failOver) problems.push(`${result.total} > ${failOver} (--fail-over)`)
    for (const problem of problems) console.error(problem)
    return problems.length > 0 ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try { process.exitCode = run() }
    catch (error) { console.error(error.message); process.exitCode = 1 }
}
