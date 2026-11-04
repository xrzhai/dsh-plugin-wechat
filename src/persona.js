/**
 * Persona modes: named conversation styles the operator (or the user, via
 * /mode) can put a conversation into — 默认助手 / 女友 / 男友 / 朋友 / 贾维斯 /
 * 小鲸娘 / 御姐 / 知心大姐姐 / 暖男 / 可爱闺女 / 猫娘 / 傲娇 plus custom entries
 * edited in the settings card.
 *
 * Two files under the state root:
 *   persona-modes.json   the catalog — id, name, prompt, builtin flag
 *   persona-active.json  per-conversation overrides — "accountId|convId": modeId
 *
 * A mode is injected as a <weixin_persona> block ahead of the user's message
 * (same seam as sourceContext). The block only ever changes TONE; the prompt
 * of every builtin says so explicitly, because a persona that rewrites facts
 * or refuses tasks would break the plugin's job.
 */
import fs from 'node:fs';
import { atomicWriteJson } from './atomic.js';
import path from 'node:path';

export const DEFAULT_MODE_ID = 'default';
export const MAX_CUSTOM_MODES = 8;
const MODES_FILE = 'persona-modes.json';
const ACTIVE_FILE = 'persona-active.json';

/**
 * The builtin modes. `default` is special: it injects nothing — it exists so
 * the user can name the absence ("换回默认") instead of remembering an
 * off-switch. The prompts below are the shipped wording; the card can edit
 * them (builtin only protects against deletion).
 */
export const BUILTIN_MODES = [
    {
        id: DEFAULT_MODE_ID,
        name: '默认助手',
        prompt: '',
        builtin: true,
    },
];

/** A warn line costs nothing when the caller has nowhere to send it. */
const noopWarn = () => {};

/** Schema stamp for persona-modes.json / persona-active.json. */
export const PERSONA_SCHEMA_VERSION = 1;

function modesPath(stateRoot) {
    return path.join(stateRoot, MODES_FILE);
}

function activePath(stateRoot) {
    return path.join(stateRoot, ACTIVE_FILE);
}

function sanitizeStore(parsed, { warn }) {
    if (Array.isArray(parsed?.modes) !== true) return undefined;
    const modes = [];
    const seen = new Set();
    for (const entry of parsed.modes) {
        if (entry === null || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
        if (id === '' || name === '' || seen.has(id)) {
            warn(`persona mode with blank id/name skipped: ${JSON.stringify(id)}`);
            continue;
        }
        seen.add(id);
        modes.push({ id, name, prompt, game: entry.game === true, builtin: entry.builtin === true });
    }
    return modes;
}

/**
 * Read the mode catalog, seeding the file on first use and re-adding any
 * builtin that a hand-edited or older file lost (a missing `default` would
 * otherwise leave /mode with no way back).
 */
export function readPersonaStore(stateRoot, { warn = noopWarn } = {}) {
    const file = modesPath(stateRoot);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        const seeded = BUILTIN_MODES.map((mode) => ({ ...mode }));
        try {
            atomicWriteJson(file, { schemaVersion: PERSONA_SCHEMA_VERSION, modes: seeded }, { warn });
        } catch (error) {
            warn(`persona store seed failed: ${String(error)}`);
        }
        return seeded;
    }
    const modes = sanitizeStore(parsed, { warn });
    if (modes === undefined) {
        warn(`persona store at ${file} is not a mode list; reseeding builtins`);
        return BUILTIN_MODES.map((mode) => ({ ...mode }));
    }
    let changed = false;
    const missing = BUILTIN_MODES.filter((builtin) => modes.some((mode) => mode.id === builtin.id) === false);
    if (missing.length > 0) {
        // An install that predates this roster gains the new modes where the
        // roster ships them, instead of reversed at the top of the list. Edits
        // to an existing builtin are kept as they are (the operator may have
        // rewritten a prompt), and custom entries keep their relative order.
        const shipped = new Set(BUILTIN_MODES.map((builtin) => builtin.id));
        const byId = new Map(modes.filter((mode) => shipped.has(mode.id)).map((mode) => [mode.id, mode]));
        const customs = modes.filter((mode) => shipped.has(mode.id) === false);
        const rebuilt = [...BUILTIN_MODES.map((builtin) => byId.get(builtin.id) ?? { ...builtin }), ...customs];
        modes.length = 0;
        modes.push(...rebuilt);
        changed = true;
    }
    if (changed === true) {
        try {
            atomicWriteJson(file, { schemaVersion: PERSONA_SCHEMA_VERSION, modes }, { warn });
        } catch (error) {
            warn(`persona store reseed failed: ${String(error)}`);
        }
    }
    return modes;
}

/** Persist a whole catalog (the settings card sends the edited list). */
export function writePersonaStore(stateRoot, modes, { warn = noopWarn } = {}) {
    atomicWriteJson(modesPath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, modes }, { warn });
}

/** Resolve a mode by id; unknown or blank ids fall back to `default`, never throw. */
export function resolveMode(modes, modeId) {
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    const id = wanted === '' ? DEFAULT_MODE_ID : wanted;
    return modes.find((mode) => mode.id === id)
        ?? modes.find((mode) => mode.id === DEFAULT_MODE_ID);
}

/**
 * Per-conversation override. The key must be stable across restarts, so it is
 * the raw `accountId|conversationId` pair — both come from the server and
 * contain no '|' themselves.
 */
export function overrideKey(accountId, conversationId) {
    return `${accountId}|${conversationId}`;
}

function readActiveFile(stateRoot, { warn }) {
    const parsed = readActiveRaw(stateRoot, { warn });
    const overrides = {};
    for (const [key, value] of Object.entries(parsed)) {
        // `__global__` (no `|`) is the account-wide default written by the
        // settings card, not a conversation override — never list it as one
        // and never let it answer a per-conversation lookup.
        if (key.includes('|') === false) continue;
        if (typeof value === 'string' && value.trim() !== '') overrides[key] = value.trim();
    }
    return overrides;
}

/** The file verbatim (reserved keys included) — for mutating round-trips. */
function readActiveRaw(stateRoot, { warn }) {
    try {
        const parsed = JSON.parse(fs.readFileSync(activePath(stateRoot), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // The version stamp lives in the same object; it is not an override and
        // must not travel back out through a round-trip.
        delete parsed.schemaVersion;
        return parsed;
    } catch {
        return {};
    }
}

/**
 * The reserved key holding the account-wide default mode (the card's
 * 「默认模式」 selector). Lives in persona-active.json so the card can change
 * it live through the remote methods — a schema field would need a reload.
 */
export const GLOBAL_DEFAULT_KEY = '__global__';

export function readGlobalDefaultMode(stateRoot, { warn = noopWarn } = {}) {
    try {
        const parsed = JSON.parse(fs.readFileSync(activePath(stateRoot), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
        const value = parsed[GLOBAL_DEFAULT_KEY];
        return typeof value === 'string' ? value.trim() : '';
    } catch {
        return '';
    }
}

/** '' clears the account-wide default (schema `personaDefaultMode` rules again). */
export function writeGlobalDefaultMode(stateRoot, modeId, { warn = noopWarn } = {}) {
    const parsed = readActiveRaw(stateRoot, { warn });
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') delete parsed[GLOBAL_DEFAULT_KEY];
    else parsed[GLOBAL_DEFAULT_KEY] = wanted;
    atomicWriteJson(activePath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, ...parsed }, { warn });
}

/** The mode a conversation currently talks in, override or global default. */
export function activeModeFor(stateRoot, accountId, conversationId, defaultModeId, { warn = noopWarn } = {}) {
    const overrides = readActiveFile(stateRoot, { warn });
    const key = overrideKey(accountId, conversationId);
    // One resolution rule for everyone (commands, prompt injection, card):
    // conversation override first, then THIS account's default persona
    // (账号级默认人设, key `accountId|`), then the file-level global default
    // the card writes, then the caller's fallback (the schema default).
    const chosen = overrides[key]
        || readAccountDefaultMode(stateRoot, accountId, { warn })
        || readGlobalDefaultMode(stateRoot, { warn })
        || (typeof defaultModeId === 'string' ? defaultModeId : DEFAULT_MODE_ID);
    return chosen;
}

/**
 * 账号级默认人设. The reserved key form `accountId|` (empty conversation side)
 * holds ONE account's default mode, layered between the per-conversation
 * overrides and the file-wide `__global__` default. Lives in
 * persona-active.json so the card can change it live through the remote
 * methods — a schema field would need a reload to matter.
 */
export function accountDefaultKey(accountId) {
    return `${accountId}|`;
}

export function readAccountDefaultMode(stateRoot, accountId, { warn = noopWarn } = {}) {
    const raw = readActiveRaw(stateRoot, { warn });
    const value = raw[accountDefaultKey(accountId)];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

export function writeAccountDefaultMode(stateRoot, accountId, modeId, { warn = noopWarn } = {}) {
    const raw = readActiveRaw(stateRoot, { warn });
    const key = accountDefaultKey(accountId);
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') delete raw[key];
    else raw[key] = wanted;
    atomicWriteJson(activePath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, ...raw }, { warn });
    return wanted === '' ? '' : raw[key];
}

/**
 * Set one conversation's override. Storing `default` itself is legitimate:
 * the global default may be a persona, and "this one conversation back to
 * the plain assistant" is exactly what /mode 默认 should pin. Clearing
 * (empty/missing id) means "follow the global default again".
 */
export function setActiveMode(stateRoot, accountId, conversationId, modeId, { warn = noopWarn } = {}) {
    // Round-trip the RAW file: readActiveFile filters reserved keys like
    // `__global__` out of its overrides view, and writing that view back
    // would erase the card's account-wide default on every /mode switch.
    const raw = readActiveRaw(stateRoot, { warn });
    const key = overrideKey(accountId, conversationId);
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') {
        delete raw[key];
    } else {
        raw[key] = wanted;
    }
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(activePath(stateRoot), `${JSON.stringify(raw, null, 2)}\n`);
    return wanted === '' ? null : raw[key];
}

export function clearActiveMode(stateRoot, accountId, conversationId, { warn = noopWarn } = {}) {
    return setActiveMode(stateRoot, accountId, conversationId, null, { warn });
}

export function listActiveOverrides(stateRoot, { warn = noopWarn } = {}) {
    const overrides = readActiveFile(stateRoot, { warn });
    return Object.entries(overrides)
        .map(([key, modeId]) => {
            const sep = key.indexOf('|');
            return {
                accountId: sep === -1 ? key : key.slice(0, sep),
                conversationId: sep === -1 ? '' : key.slice(sep + 1),
                modeId,
            };
        })
        // `accountId|` (empty conversation side) is the account-level default,
        // not a per-conversation override — the card shows it in the mode
        // panel, never in this list.
        .filter((entry) => entry.conversationId !== '');
}

/**
 * The prompt block for one mode. `default` (and any mode with an empty
 * prompt) injects NOTHING — an empty tag would just spend tokens.
 */
export function buildPersonaBlock(mode) {
    if (mode === undefined || mode === null) return '';
    if (typeof mode.prompt !== 'string' || mode.prompt.trim() === '') return '';
    return `<weixin_persona mode="${mode.name}">\n${mode.prompt.trim()}\n</weixin_persona>`;
}
