import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './state.js'

function sessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError('Expected a nonempty session ID')
  }
  return value
}

function idsFromJson(json) {
  if (typeof json !== 'string') throw new TypeError('Expected a JSON array of session IDs')
  const values = JSON.parse(json)
  if (!Array.isArray(values)) throw new TypeError('Expected an array of session IDs')
  return new Set(values.map(sessionId))
}

// Multiple desktop windows can share the same profile. SQLite serializes their
// deltas and releases the write lock even if a process exits mid-transaction.
async function withArchive(fn) {
  const { DatabaseSync } = await import('node:sqlite')
  const root = stateDir()
  fs.mkdirSync(root, { recursive: true })
  const db = new DatabaseSync(path.join(root, 'archived-children.sqlite'))
  try {
    db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS archived_children (
        parent TEXT NOT NULL, child TEXT NOT NULL, PRIMARY KEY(parent, child)
      ) WITHOUT ROWID`)
    return fn(db)
  } finally {
    db.close()
  }
}

function read(db, parent) {
  return { ids: db.prepare('SELECT child FROM archived_children WHERE parent = ? ORDER BY child')
    .all(parent).map(row => row.child) }
}

export async function archivedChildren(parent) {
  sessionId(parent)
  return withArchive(db => read(db, parent))
}

export async function updateArchivedChildren(parent, addJson, removeJson) {
  sessionId(parent)
  const add = idsFromJson(addJson)
  const remove = idsFromJson(removeJson)
  return withArchive(db => {
    db.exec('BEGIN IMMEDIATE')
    const insert = db.prepare('INSERT OR IGNORE INTO archived_children(parent, child) VALUES (?, ?)')
    const erase = db.prepare('DELETE FROM archived_children WHERE parent = ? AND child = ?')
    for (const id of add) insert.run(parent, id)
    for (const id of remove) erase.run(parent, id)
    const result = read(db, parent)
    db.exec('COMMIT')
    return result
    // withArchive closes the connection on failure, rolling back the transaction.
  })
}
