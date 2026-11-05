import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRichContent } from '../../src/message/rich-content.js'

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
