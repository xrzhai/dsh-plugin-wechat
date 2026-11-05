// Per-conversation configuration overrides.
//
// The config schema has always been global-then-account: one set of values for
// the whole plugin, optionally narrowed per bot account. That is the wrong
// shape for the settings people actually want to change per chat. Older
// releases let a conversation override pacing, memory and persona fields; those
// runtime features no longer exist, so the allowlist below is only the current
// intersection that the message path can still layer safely.
//
// This module stores overrides keyed by (accountId, conversationId) and layers
// them over the account config for one message. Only the keys listed in
// SCOPABLE_KEYS may be overridden: an override that could move a credential or
// an allowlist is a security footgun dressed as a convenience, and nothing on
// this list can widen who may talk to the bot.

import { statePath } from './state-layout.js'

import { atomicWriteJson, readJsonFile } from './atomic.js';

/** Keys a conversation is allowed to override. Add deliberately. */
export const SCOPABLE_KEYS = Object.freeze([
  'maxMessageLength',
  'markdownMode',
  'typingIndicator',
  'usageAwarenessEnabled',
  'knowledgeEnabled',
]);

const SCOPE_VERSION = 1;

export function scopeFilePath(stateRoot) {
  return statePath(stateRoot, 'configScope');
}

function keyFor(accountId, conversationId) {
  return `${accountId ?? ''}|${conversationId ?? ''}`;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeScope(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const scope = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SCOPABLE_KEYS.includes(key) !== true) continue;
    const clean = sanitizeValue(value);
    if (clean !== undefined) scope[key] = clean;
  }
  return Object.keys(scope).length === 0 ? undefined : scope;
}

function readScopeStore(stateRoot, { warn } = {}) {
  const store = readJsonFile(scopeFilePath(stateRoot), {
    version: SCOPE_VERSION,
    fallback: () => ({ scopes: {} }),
    warn,
  });
  const scopes = store?.scopes;
  return {
    ...store,
    scopes: scopes !== null && typeof scopes === 'object' && !Array.isArray(scopes) ? scopes : {},
  };
}

/** All overrides, as `{ 'account|conversation': { key: value } }`. */
export function readScopes(stateRoot, { warn } = {}) {
  const store = readScopeStore(stateRoot, { warn });
  const scopes = {};
  for (const [key, value] of Object.entries(store?.scopes ?? {})) {
    const scope = sanitizeScope(value);
    if (scope !== undefined) scopes[key] = scope;
  }
  return scopes;
}

/** The override for one conversation, or undefined when it has none. */
export function readScope(stateRoot, accountId, conversationId, options) {
  const scopes = readScopes(stateRoot, options);
  return scopes[keyFor(accountId, conversationId)];
}

/**
 * Replace (or, with an empty patch, clear) one conversation's overrides.
 * Returns what was stored, so the caller can echo it back.
 */
export function writeScope(stateRoot, accountId, conversationId, patch, { warn } = {}) {
  // Keep the raw store for the write. readScopes intentionally filters keys
  // that no longer have a runtime consumer, but rewriting a new override must
  // not erase an older config-scope.json wholesale or destroy another
  // conversation's values. Unsupported keys remain dormant on disk; only the
  // explicit empty-patch clear removes this conversation's record.
  const store = readScopeStore(stateRoot, { warn });
  const scopes = { ...store.scopes };
  const key = keyFor(accountId, conversationId);
  const existing = scopes[key];
  const existingScope = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? existing : undefined;
  const scope = sanitizeScope(patch ?? {});
  if (scope === undefined) {
    if (patch !== null && typeof patch === 'object' && Object.keys(patch).length > 0) return sanitizeScope(existingScope);
    delete scopes[key];
  } else {
    scopes[key] = { ...existingScope, ...scope };
  }
  atomicWriteJson(scopeFilePath(stateRoot), { ...store, schemaVersion: SCOPE_VERSION, scopes }, { warn });
  return sanitizeScope(scopes[key]);
}

/** Layer a scope over the account config. Unknown keys were already dropped. */
export function scopedConfig(base, scope) {
  if (scope === undefined || scope === null) return base;
  const layered = { ...base };
  for (const key of SCOPABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(scope, key)) layered[key] = scope[key];
  }
  return layered;
}

/** Is this conversation overriding anything at all? Used by the card and /status. */
export function describeScope(scope) {
  if (scope === undefined) return '';
  return Object.entries(scope)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}
