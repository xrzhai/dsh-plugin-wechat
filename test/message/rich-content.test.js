import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { planRichContent, writeSnippets } from '../../src/message/rich-content.js'

test('short fenced Markdown tables stay unchanged inline', () => {
  const block = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
  const markdown = ['```markdown', block, '```'].join('\n')

  assert.deepEqual(planRichContent(markdown, { codeFileChars: 1200 }), {
    text: block,
    files: [],
    notes: [],
  })
})

test('long fenced Markdown tables keep their source in snippet files', () => {
  const block = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
  const markdown = ['```markdown', block, '```'].join('\n')

  const result = planRichContent(markdown, { codeFileChars: 1 })

  assert.deepEqual(result.files, [{ name: 'snippet-1.md', body: block }])
})

test('unfenced Markdown tables are still rendered as aligned text', () => {
  const markdown = ['before', '| Name | Value |', '|---|---|', '| A | 1 |', 'after'].join('\n')

  assert.equal(planRichContent(markdown).text, 'before\nName  Value\nA     1\nafter')
})

test('a filename collision never overwrites an existing snippet', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-collision-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const originalWrite = fs.writeFileSync
  let collidedPath
  t.mock.method(fs, 'writeFileSync', (target, content, options) => {
    collidedPath = target
    originalWrite(target, 'existing synthetic content', { flag: 'wx' })
    return originalWrite(target, content, options)
  })

  const result = writeSnippets([{ name: 'snippet-1.js', body: 'new synthetic content' }], dir)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.written, [])
  assert.equal(fs.readFileSync(collidedPath, 'utf8'), 'existing synthetic content')
})
