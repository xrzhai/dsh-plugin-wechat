// Core plugin state paths. Historical files are left in place.

import path from 'node:path';

/**
 * The layout. `dir` entries are directories the plugin owns; `file` entries are
 * single-file stores.
 */
export const STATE_LAYOUT = Object.freeze({
  accounts: { kind: 'dir', relative: 'openclaw-weixin', label: '账号凭证' },
  sessions: { kind: 'file', relative: 'sessions.json', label: '会话线' },
  outbox: { kind: 'file', relative: 'outbox.json', label: '待发队列' },
  instanceLock: { kind: 'file', relative: 'instance.lock', label: '实例锁' },
  mediaInboundDir: { kind: 'dir', relative: 'media/inbound', label: '收到的媒体' },
  snippetsDir: { kind: 'dir', relative: 'snippets', label: '代码片段' },
  logsDir: { kind: 'dir', relative: 'logs', label: '运行日志' },
});

/** Every entry, with its resolved absolute path. */
export function statePaths(stateRoot) {
  const root = path.resolve(stateRoot);
  const resolved = {};
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    resolved[key] = { ...entry, absolute: path.join(root, entry.relative) };
  }
  return resolved;
}

/** Resolve one entry by key; throws on a typo instead of writing somewhere new. */
export function statePath(stateRoot, key) {
  const entry = STATE_LAYOUT[key];
  if (entry === undefined) throw new Error(`unknown state entry: ${key}`);
  return path.join(path.resolve(stateRoot), entry.relative);
}
