import test from 'node:test'
import assert from 'node:assert/strict'
import { unusedImports } from '../bin/lib/unused-imports.mjs'

test('unused import check understands aliases, namespaces, exports and side effects', () => {
  assert.deepEqual(unusedImports(`import { x as renamed } from 'x';
import * as ns from 'n'; import d from 'd'; import 'side-effect';
export { renamed }; export const value = ns.read(d);`), [])
})

test('comments, literal mentions and shadowing do not hide unused imports', () => {
  assert.deepEqual(unusedImports(`import { dead } from 'x';
// dead
const label = 'dead';
export function run(dead) { return dead + label }`), [{ name: 'dead', line: 1 }])
})

test('writing an import does not count as using its imported value', () => {
  assert.deepEqual(unusedImports("import { x } from 'x'; x = 1"), [{ name: 'x', line: 1 }])
})
