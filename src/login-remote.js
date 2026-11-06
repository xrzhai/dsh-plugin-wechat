// WeixinLoginController — settings-page login orchestration.
//
// Reuses the vendored low-level API helpers (apiGetFetch/apiPostFetch) and the
// account store, but runs its own polling state machine: the CLI
// waitForWeixinLogin() blocks on stdin for the verify-code step, which is
// unusable from the settings UI. Here the verify code is submitted by the UI
// through submitVerifyCode() instead.
import { randomUUID } from "node:crypto";
import { TypertRemoteService, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { apiGetFetch, apiPostFetch } from "../vendor/openclaw-weixin/api/api.js";
import {
    loadWeixinAccount,
    listIndexedWeixinAccountIds,
    saveWeixinAccount,
    registerWeixinAccountId,
    clearWeixinAccount,
    unregisterWeixinAccountId,
} from "../vendor/openclaw-weixin/auth/accounts.js";
import { logger } from "../vendor/openclaw-weixin/util/logger.js";
import { redactToken } from "../vendor/openclaw-weixin/util/redact.js";
import { allowlistForAccount, isAccountPaused, readRegistry, setAccountAllowlist, setAccountLabel, setAccountPaused } from "./account-registry.js";
import { translate } from "./i18n.js";
import { readSavedConfig, stateDir } from "./state.js";
import { DEFAULT_RETENTION, directoryUsage } from "./message/retention.js";
import { readOutbox } from "./message/outbox.js";
import { remoteMethods } from "./typert-js.js";
import { detectHostVersion, hostStatus } from "./host-compat.js";
import { buildOnboardingChecklist } from "./onboarding.js";
import { qrDataUrl } from "./qr-png.js";
import fs from "node:fs";
import path from "node:path";
import { SessionLines, accountScope } from "./sessions.js";
import { readJournal, DEFAULT_JOURNAL_LIMIT } from "./message/journal.js";
import { readJournalRange, renderChatMarkdown } from "./message/chat-export.js";
import { computeStats, buildHealth } from "./message/stats.js";
import { conversationRows, ledgerTotals } from "./message/usage-ledger.js";
import { readBudget } from "./budget.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const LOGIN_TTL_MS = 5 * 60 * 1000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 480_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const QR_STATUS_VALUES = new Set([
    "wait",
    "scaned",
    "need_verifycode",
    "expired",
    "verify_code_blocked",
    "binded_redirect",
    "scaned_but_redirect",
    "confirmed",
]);

const logins = new Map(); // sessionKey -> active login record

function normalizeAccountId(accountId) {
    return String(accountId ?? "").trim();
}

function isFresh(login, now = Date.now()) {
    return now < login.deadlineAt && now - login.lastActivityAt < LOGIN_TTL_MS;
}

function isPastLoginDeadline(login, now = Date.now()) {
    return now >= login.deadlineAt;
}

function timedOutLoginResult() {
    return {
        status: "failed",
        reason: "login_timeout",
        message: "登录已超时，请重新扫码。",
    };
}

function classifyPollError(error) {
    if (error instanceof SyntaxError) {
        return {
            reason: "invalid_response",
            message: "微信登录服务返回异常，正在重试。",
            failureMessage: `连续 ${MAX_CONSECUTIVE_POLL_ERRORS} 次无法获得有效的登录响应，本次登录已停止，请稍后重试。`,
        };
    }
    return {
        reason: "network_error",
        message: "连接微信登录服务失败，正在重试。",
        failureMessage: `连续 ${MAX_CONSECUTIVE_POLL_ERRORS} 次无法连接微信登录服务，本次登录已停止，请检查网络后重试。`,
    };
}

function getLocalTokenList() {
    const out = [];
    const ids = listIndexedWeixinAccountIds();
    for (const id of ids.reverse()) {
        try {
            const acct = loadWeixinAccount(id);
            if (acct?.token) out.push(acct.token);
        } catch {
            // unreadable account files are not fatal for listing tokens
        }
        if (out.length >= 10) break;
    }
    return out;
}

async function fetchQrCode(botType, request = apiPostFetch) {
    const raw = await request({
        baseUrl: FIXED_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: JSON.stringify({ local_token_list: getLocalTokenList() }),
        label: "fetchQRCode",
    });
    const data = JSON.parse(raw);
    if (!data?.qrcode || !data?.qrcode_img_content) {
        throw new Error("获取二维码失败：服务器返回不完整");
    }
    return data;
}

async function pollQrStatus(baseUrl, qrcode, verifyCode, request = apiGetFetch) {
    try {
        const raw = await request({
            baseUrl,
            endpoint:
                `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}` +
                (verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""),
            timeoutMs: 35_000,
            label: "pollQRStatus",
        });
        const status = JSON.parse(raw);
        if (typeof status?.status !== "string" || !QR_STATUS_VALUES.has(status.status)) {
            throw new SyntaxError("QR status response has no recognized status");
        }
        return status;
    } catch (error) {
        // A client-side timeout is the normal end of a long poll: the server
        // had no transition to report. Every other failure must remain visible.
        if (error?.name === "AbortError") return { status: "wait" };
        throw error;
    }
}

export class WeixinLoginController extends TypertRemoteService {
    static inject = ["typert"];

    constructor(ctx, options = {}) {
        super(ctx, "weixinLoginController", { namespace: "weixin" });
        this.botType = options.botType ?? DEFAULT_BOT_TYPE;
        this.getWorkspaceDirectory = options.getWorkspaceDirectory;
        // Network and rendering seams used by tests to hold individual calls
        // open. Production always uses the vendored fetch helpers.
        this.apiGetFetch = options.apiGetFetch ?? apiGetFetch;
        this.apiPostFetch = options.apiPostFetch ?? apiPostFetch;
        this.makeQrDataUrl = options.makeQrDataUrl ?? qrDataUrl;
        // Account-store seams keep failure semantics testable without relying
        // on platform-specific permission tricks.
        this.loadAccount = options.loadAccount ?? loadWeixinAccount;
        this.clearAccount = options.clearAccount ?? clearWeixinAccount;
        this.unregisterAccount = options.unregisterAccount ?? unregisterWeixinAccountId;
        this.persistAccountPaused = options.persistAccountPaused ?? setAccountPaused;
        this.now = typeof options.now === "function" ? options.now : Date.now;
        this.startingLogin = undefined;
        this.loginRevision = 0;
        this.sessionExpiredAccounts = new Set();
        this.unscopedSessionExpired = false;
        /**
         * Called after a login writes a new credential, so the host can start
         * (or restart) the inbound loop without waiting for a reload. Assigned
         * by the plugin's listen effect; undefined in the CLI and in tests.
         *
         * A PLAIN property, deliberately not a `#private` field: the gateway
         * calls a Remote method on the traced Proxy it reads back from the
         * Cordis context, and a Proxy does not forward private-field identity.
         * @type {(() => void) | undefined}
         */
        this.onAccountBound = undefined;
        /**
         * Set by the plugin's setup once the reminder scheduler exists; the
         * journal/reminders card methods read through it. Undefined in the
         * CLI and in tests — the methods below must answer honestly when it
         * is missing instead of pretending the feature is broken.
         */
        this.remindersProvider = undefined;
        /** Set by the plugin's setup: the live outbox. */
        this.outboxFlush = undefined;
        this.outboxDropItem = undefined;
    }

    /** Start (or resume) a QR login; returns {qrcodeUrl, qrDataUrl, sessionKey, status}. */
    async startLogin() {
        const now = this.now();
        // A new click is an explicit replacement. Drop expired records even if
        // an old request is still unwinding; its identity check will then stop
        // the late response from binding an account behind the new login.
        purgeStaleLogins(now, { includeActive: true, includeIdle: true });
        const existing = [...logins.values()].find((l) => isFresh(l, now) && l.qrcodeUrl);
        if (existing) {
            return {
                qrcodeUrl: existing.qrcodeUrl,
                qrDataUrl: existing.qrDataUrl,
                sessionKey: existing.sessionKey,
                status: "wait",
            };
        }
        // A double-click or two connected clients can reach this method before
        // the first QR request has inserted anything into `logins`. Share that
        // request so one controller never creates two live confirmation paths.
        if (this.startingLogin) return this.startingLogin;
        const revision = this.loginRevision;
        const pending = this.issueLogin(revision);
        this.startingLogin = pending;
        try {
            return await pending;
        } finally {
            if (this.startingLogin === pending) this.startingLogin = undefined;
        }
    }

    async issueLogin(revision) {
        const data = await fetchQrCode(this.botType, this.apiPostFetch);
        if (revision !== this.loginRevision) return { status: "cancelled" };
        const sessionKey = randomUUID();
        const link = data.qrcode_img_content;
        // Best-effort QR image; the clickable link is always a usable fallback.
        const qrDataUrlValue = await this.makeQrDataUrl(link).catch(() => undefined);
        if (revision !== this.loginRevision) return { status: "cancelled" };
        const issuedAt = this.now();
        logins.set(sessionKey, {
            sessionKey,
            qrcode: data.qrcode,
            qrcodeUrl: link,
            qrDataUrl: qrDataUrlValue,
            // Kept for compatibility with older diagnostics; total login time
            // comes from createdAt/deadlineAt and is never extended by refresh.
            startedAt: issuedAt,
            createdAt: issuedAt,
            deadlineAt: issuedAt + LOGIN_TIMEOUT_MS,
            lastActivityAt: issuedAt,
            inFlightPolls: 0,
            consecutivePollErrors: 0,
            refreshCount: 0,
            pendingVerifyCode: null,
            baseUrl: FIXED_BASE_URL,
        });
        logger.info(
            `weixin login: QR issued session=${redactToken(sessionKey)} qrcode=${redactToken(data.qrcode)} linkLen=${link.length}`,
        );
        return { qrcodeUrl: link, qrDataUrl: qrDataUrlValue, sessionKey, status: "wait" };
    }

    /**
     * One poll step. The server long-polls (about 30s) before it answers, so the
     * card calls this again only once the previous call has returned; it must not
     * be driven from a fixed interval, or the requests stack up.
     */
    async poll(sessionKey) {
        const login = logins.get(sessionKey);
        if (!login) throw new RemoteError("no_login", "没有进行中的登录，请重新扫码", {});
        const startedAt = this.now();
        if (isPastLoginDeadline(login, startedAt)) {
            logins.delete(sessionKey);
            return timedOutLoginResult();
        }
        login.inFlightPolls += 1;
        login.lastActivityAt = startedAt;
        let status;
        try {
            status = await pollQrStatus(login.baseUrl, login.qrcode, login.pendingVerifyCode, this.apiGetFetch);
        } catch (error) {
            // cancel()/logout() may have removed this exact record while the
            // failed request was open. That is not a network failure to report.
            if (logins.get(sessionKey) !== login) return { status: "cancelled" };
            const failedAt = this.now();
            login.lastActivityAt = failedAt;
            if (isPastLoginDeadline(login, failedAt)) {
                logins.delete(sessionKey);
                return timedOutLoginResult();
            }
            const failure = classifyPollError(error);
            login.consecutivePollErrors += 1;
            logger.warn(
                `weixin login: poll ${failure.reason} attempt=${login.consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS} session=${redactToken(sessionKey)}`,
            );
            if (login.consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
                logins.delete(sessionKey);
                return {
                    status: "failed",
                    reason: failure.reason,
                    message: failure.failureMessage,
                };
            }
            return {
                status: "retrying",
                reason: failure.reason,
                attempt: login.consecutivePollErrors,
                maxAttempts: MAX_CONSECUTIVE_POLL_ERRORS,
                message: `${failure.message}（${login.consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}）`,
            };
        } finally {
            login.inFlightPolls = Math.max(0, login.inFlightPolls - 1);
        }
        // cancel()/logout() remove this exact record while the request is open.
        // A later response belongs to a dead login and must have no side effects.
        // The identity check also makes concurrent polls safe: after the first
        // confirmed result removes the record, later duplicates stop here.
        if (logins.get(sessionKey) !== login) return { status: "cancelled" };
        const completedAt = this.now();
        login.lastActivityAt = completedAt;
        // A request that was already in flight at the deadline may still have a
        // successful confirmation. Give that terminal answer priority; reject
        // every non-terminal result once the total time limit has elapsed.
        if (status.status !== "confirmed" && isPastLoginDeadline(login, completedAt)) {
            logins.delete(sessionKey);
            return timedOutLoginResult();
        }
        login.consecutivePollErrors = 0;
        // The login flow used to leave no trace at all, which made a scan that
        // went nowhere impossible to diagnose after the fact.
        logger.debug(
            `weixin login: polled status=${status?.status ?? "(none)"} session=${redactToken(sessionKey)} scanned=${Boolean(status?.ilink_user_id)}`,
        );
        switch (status.status) {
            case "wait":
                return { status: "wait" };
            case "scaned":
                if (login.pendingVerifyCode) login.pendingVerifyCode = null;
                return { status: "scaned" };
            case "need_verifycode":
                return {
                    status: "need_verifycode",
                    message:
                        login.pendingVerifyCode != null
                            ? "验证码不匹配，请输入手机上显示的最新数字"
                            : "请输入手机微信上显示的验证码数字",
                };
            case "expired":
            case "verify_code_blocked": {
                if (status.status === "verify_code_blocked") login.pendingVerifyCode = null;
                login.refreshCount += 1;
                if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
                    logins.delete(sessionKey);
                    return { status: "failed", message: "二维码多次失效，请重新开始登录" };
                }
                const fresh = await fetchQrCode(this.botType, this.apiPostFetch);
                if (logins.get(sessionKey) !== login) return { status: "cancelled" };
                const freshQrDataUrl = await this.makeQrDataUrl(fresh.qrcode_img_content).catch(() => undefined);
                if (logins.get(sessionKey) !== login) return { status: "cancelled" };
                login.qrcode = fresh.qrcode;
                login.qrcodeUrl = fresh.qrcode_img_content;
                login.qrDataUrl = freshQrDataUrl;
                login.startedAt = this.now();
                login.lastActivityAt = login.startedAt;
                return { status: "refreshed", qrcodeUrl: login.qrcodeUrl, qrDataUrl: login.qrDataUrl };
            }
            case "binded_redirect": {
                // The server still has this bot bound to this install, so it
                // refuses to hand out a new credential. The vendored CLI reads
                // that as an idempotent success ("已连接过此 OpenClaw"), which is
                // only true when this host still holds the token; after a log out
                // the token is gone and the bot cannot be unbound from here, so
                // the honest answer is a distinct outcome the card can explain.
                logins.delete(sessionKey);
                logger.info(
                    `weixin login: server refused a new credential (binded_redirect) session=${redactToken(sessionKey)} localAccounts=${listIndexedWeixinAccountIds().length}`,
                );
                return {
                    status: "alreadyBound",
                    message:
                        "服务器仍认为该机器人绑定在本机，但本地凭证已被退出登录删除。请先在手机微信里解除该机器人的绑定，然后重新扫码。",
                };
            }
            case "scaned_but_redirect":
                if (status.redirect_host) login.baseUrl = `https://${status.redirect_host}`;
                return { status: "scaned" };
            case "confirmed": {
                logins.delete(sessionKey);
                if (!status.ilink_bot_id) {
                    return { status: "failed", message: "服务器未返回账号 ID，登录未完成" };
                }
                saveWeixinAccount(status.ilink_bot_id, {
                    token: status.bot_token,
                    baseUrl: status.baseurl,
                    userId: status.ilink_user_id,
                });
                registerWeixinAccountId(status.ilink_bot_id);
                logger.info(
                    `weixin login: confirmed account=${status.ilink_bot_id} user=${redactToken(status.ilink_user_id)} token=${redactToken(status.bot_token)}`,
                );
                // A completed login writes a usable credential, so any expiry
                // recorded from an earlier session no longer applies.
                this.clearSessionExpired(status.ilink_bot_id);
                // The loop that is running belongs to the credential that was
                // on disk when it started — which is the one this login just
                // replaced, or nothing at all on a fresh install. Tell the host
                // to bring it up for the credential that now exists: without
                // this the operator binds successfully and WeChat still says it
                // cannot reach openclaw until the next reload.
                try {
                    // The bound account travels with the callback: the host keeps
                    // one transport per account, and only the one whose credential
                    // just changed may be re-armed. Calling it bare would force
                    // the host to guess which account to bring up.
                    this.onAccountBound?.(status.ilink_bot_id);
                } catch (error) {
                    logger.warn(`weixin login: onAccountBound failed: ${String(error)}`);
                }
                return {
                    status: "confirmed",
                    accountId: status.ilink_bot_id,
                    userId: status.ilink_user_id,
                };
            }
            default:
                return { status: "wait" };
        }
    }

    /** Submit the verify code shown on the phone for the next poll to use. */
    async submitVerifyCode(sessionKey, code) {
        const login = logins.get(sessionKey);
        if (!login) throw new RemoteError("no_login", "没有进行中的登录，请重新扫码", {});
        login.pendingVerifyCode = String(code ?? "").trim();
        return { accepted: true };
    }

    /** Drop an in-flight login (user closed the page / pressed cancel). */
    async cancel(sessionKey) {
        logins.delete(sessionKey);
        return { cancelled: true };
    }

    /**
     * Forget a bound account: delete its saved credentials and drop it from the
     * index, so the card returns to "not logged in".
     *
     * Only the credential is removed. Session history and the operator's own
     * settings (allowlist, model directory) live elsewhere and are deliberately
     * kept — logging out is "stop using this account", not "erase the setup".
     *
     * There is no server-side revocation to call: the token is a session, and
     * dropping it locally is what makes the plugin stop using it. A bot the
     * server no longer serves cannot be unbound from here either — this only
     * stops *this* host from trying.
     *
     * The poll loop keeps the credentials it started with until it restarts, so
     * a logout takes full effect on the next reload; the card says so.
     */
    async logout(accountId) {
        // Invalidate QR issuance that had not reached `logins` yet, then drop
        // every poll that did. Logout must win even when no old account remains.
        this.loginRevision += 1;
        logins.clear();
        const wanted = normalizeAccountId(accountId);
        const ids = wanted ? [wanted] : listIndexedWeixinAccountIds();
        if (ids.length === 0) {
            return { removed: [], reloadRequired: false };
        }
        const removed = [];
        for (const id of ids) {
            // Only touch accounts we actually hold: a caller must not be able to
            // name an arbitrary path, and a typo should not report success.
            const acct = this.loadAccount(id);
            if (!acct?.token) continue;
            this.clearAccount(id);
            this.unregisterAccount(id);
            removed.push(id);
            // Expiry describes whether the saved credential is usable. Only a
            // completed deletion proves that warning no longer needs action.
            this.sessionExpiredAccounts.delete(id);
        }
        // A legacy aggregate flag has no account identity. Clear it only after
        // logout-all completed for every indexed account it was meant to remove.
        if (!wanted && ids.length > 0 && removed.length === ids.length) {
            this.unscopedSessionExpired = false;
        }
        return { removed, reloadRequired: removed.length > 0 };
    }

    /** Account status for the settings card: which account is bound, state dir. */
    async status() {
        const now = this.now();
        purgeStaleLogins(now);
        const ids = listIndexedWeixinAccountIds();
        const accounts = [];
        for (const id of ids) {
            try {
                const acct = this.loadAccount(id);
                if (acct?.token) {
                    // Registry side-table data: label/paused/lastSeenAt live
                    // outside the credential on purpose (see account-registry.js).
                    // A missing entry means "never touched" — defaults, not an error.
                    const entry = readRegistry()[id] ?? {};
                    // The EFFECTIVE allowlist for this account (account override
                    // over the global config), so the card shows what actually
                    // rules this account rather than one layer of it.
                    const effective = allowlistForAccount(id, readSavedConfig());
                    accounts.push({
                        accountId: id,
                        userId: acct.userId ?? null,
                        label: typeof entry.label === "string" ? entry.label : null,
                        paused: isAccountPaused(id),
                        sessionExpired: this.sessionExpiredAccounts.has(id),
                        lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null,
                        allowedSenders: effective.allowedSenders,
                        allowedChats: effective.allowedChats,
                    });
                }
            } catch {
                // skip unreadable entries
            }
        }
        // An expired session is the one failure a saved token cannot reveal: the
        // file is present and complete, but the server refuses it, so inbound
        // messaging stops while the card still shows "bound". The transport
        // records the refusal here so the card can say "log in again".
        // Status is observational: a transient credential read failure or a
        // momentary token gap must not erase a warning that only a successful
        // login or completed logout can resolve.
        // Keep the old top-level boolean for older clients, while each account
        // now carries the flag that actually tells one login from another.
        return {
            accounts,
            stateDir: stateDir(),
            pendingLogin: logins.size > 0,
            sessionExpired: this.sessionExpired,
        };
    }

    /**
     * Pause one account's inbound loop without logging it out.
     *
     * Pausing is "stop listening on purpose": the credential stays, so resuming
     * needs no re-scan. The host's next bring-up pass (this call re-arms the
     * host immediately via `onAccountControlChange`) skips paused accounts.
     */
    /** Pending reminders for the settings card, soonest first. */
    async reminders() {
        if (this.remindersProvider === undefined) return { entries: [], available: false };
        const entries = this.remindersProvider.list().map((r) => ({
            id: r.id,
            accountId: r.accountId,
            conversationId: r.conversationId,
            fireAt: r.fireAt,
            text: r.text,
        }));
        return { entries, available: true };
    }

    /** Cancel one pending reminder from the settings card. */
    async remindCancel(id) {
        if (this.remindersProvider === undefined) return { removed: false, error: "\u8c03\u5ea6\u5668\u4e0d\u53ef\u7528" };
        const removed = this.remindersProvider.cancel(String(id));
        return removed ? { removed: true } : { removed: false, error: "\u6ca1\u6709\u8fd9\u4e2a\u7f16\u53f7" };
    }

    /** Message journal for the settings card: newest first, optional account filter. */
    async journal(options) {
        const opts = options ?? {};
        const limitRaw = Number(opts.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : DEFAULT_JOURNAL_LIMIT;
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        const beforeRaw = Number(opts.before);
        const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
        const conversationId = typeof opts.conversationId === "string" && opts.conversationId !== "" ? opts.conversationId : undefined;
        return { entries: readJournal(stateDir(), { limit, accountId, before, conversationId }) };
    }

    /**
     * Render the journal (optionally one account, last `days` days) as a
     * Markdown document for the settings card's one-click export. The card
     * downloads the text itself — no file has to travel through the plugin.
     */
    async journalExport(options) {
        const opts = options ?? {};
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        const daysRaw = Number(opts.days);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 365) : 30;
        const entries = readJournalRange(stateDir(), { accountId, days });
        const markdown = renderChatMarkdown(entries, { title: accountId ? `聊天记录 · ${accountId}` : "聊天记录" });
        return { count: entries.length, chars: markdown.length, markdown };
    }

    /**
     * 统计页签: in/out counts, a daily series, the 24-hour distribution and the
     * busiest conversations — computed from the journal on every read, so it
     * can never disagree with the journal tab next to it.
     */
    /**
     * How much room the state directory is taking, and how long each class is
     * kept. The card shows it under 「统计」 so an operator can tell a year of
     * history from a week without opening a terminal.
     */
    /**
     * Undelivered text held by the outbox. A reply that could not be sent is
     * kept on disk rather than lost; the card lists it so the operator can retry
     * or drop it instead of wondering whether the bot answered.
     */
    outbox() {
        const store = readOutbox(stateDir());
        return {
            items: store.items.map((item) => ({
                id: item.id,
                accountId: item.accountId,
                conversationId: item.conversationId,
                text: item.text,
                createdAt: item.createdAt,
                attempts: item.attempts,
                lastError: item.lastError,
            })),
        };
    }

    /** Ask the plugin to retry everything now. */
    async outboxRetry() {
        const flush = this.outboxFlush;
        if (typeof flush !== "function") return { ok: false, reason: "outbox-not-wired" };
        const result = await flush({ force: true });
        return { ok: true, ...result };
    }

    /** Drop one queued item by id. */
    outboxDrop({ id }) {
        const drop = this.outboxDropItem;
        if (typeof drop !== "function") return { ok: false, reason: "outbox-not-wired" };
        return { ok: drop(id) };
    }

    /**
     * What a migration pack would contain, before anyone types a passphrase.
     * The card uses this to show the size honestly and to offer "leave the
     * photos behind" — `media/` is usually the bulk of a state directory.
     */
    async migrateSummary() {
        const root = stateDir();
        const plain = { files: 0, bytes: 0 };
        const media = { files: 0, bytes: 0 };
        const walk = (relative) => {
            let entries = [];
            try {
                entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (relative === "" && (entry.name === "backups" || entry.name === "node_modules")) continue;
                    walk(relative === "" ? entry.name : `${relative}/${entry.name}`);
                } else if (entry.isFile()) {
                    if (relative === "" && entry.name === "instance.lock") continue;
                    let size = 0;
                    try {
                        size = fs.statSync(path.join(root, relative, entry.name)).size;
                    } catch {
                        continue;
                    }
                    const isMedia = relative === "media" || relative.startsWith("media/");
                    if (isMedia) {
                        media.files += 1;
                        media.bytes += size;
                    } else {
                        plain.files += 1;
                        plain.bytes += size;
                    }
                }
            }
        };
        walk("");
        return {
            stateRoot: root,
            withoutMedia: plain,
            media,
            withMedia: { files: plain.files + media.files, bytes: plain.bytes + media.bytes },
        };
    }

    /**
     * Seal the whole state directory into one passphrase-protected file, written
     * on this machine. The card cannot move bytes between machines, so it shows
     * the path and the operator copies that one file across.
     *
     * @param {{ passphrase?: string, includeMedia?: boolean }} options
     */
    async migrateExport(options) {
        const { sealState } = await import("./backup-crypto.js");
        const passphrase = typeof options?.passphrase === "string" ? options.passphrase : "";
        if (passphrase.length < 8) return { error: "口令至少 8 个字符 —— 它保护的是聊天原文与登录 token" };
        const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 17);
        const outFile = path.join(stateDir(), "backups", `migrate-${stamp}.enc`);
        try {
            const result = sealState(stateDir(), {
                passphrase,
                outFile,
                includeMedia: options?.includeMedia !== false,
                warn: () => {},
            });
            return { file: result.file, files: result.files, bytes: result.bytes };
        } catch (error) {
            return { error: String(error?.message ?? error) };
        }
    }

    /**
     * Open a pack on this machine and report what restoring it would write,
     * without writing a single byte. The card shows that plan and asks again;
     * `migrateRestore` is the second click.
     *
     * @param {{ file?: string, passphrase?: string }} options
     */
    async migrateInspect(options) {
        const { openState } = await import("./backup-crypto.js");
        const file = typeof options?.file === "string" ? options.file.trim() : "";
        const passphrase = typeof options?.passphrase === "string" ? options.passphrase : "";
        if (file === "") return { error: "需要一个 .enc 迁移包文件的路径" };
        if (fs.existsSync(file) === false) return { error: `找不到文件：${file}` };
        try {
            const opened = openState(file, { passphrase });
            const root = path.resolve(stateDir());
            const preview = [];
            let bytes = 0;
            let replaces = 0;
            for (const [rel, buffer] of opened.files) {
                bytes += buffer.length;
                const exists = fs.existsSync(path.join(root, rel));
                if (exists) replaces += 1;
                preview.push({ path: rel, bytes: buffer.length, exists });
            }
            return {
                file,
                sealedAt: typeof opened.sealedAt === "string" ? opened.sealedAt : "",
                files: preview.length,
                bytes,
                replaces,
                adds: preview.length - replaces,
                hasConfig: preview.some((entry) => entry.path === "config.json"),
                sample: preview.slice(0, 12),
            };
        } catch (error) {
            const message = String(error?.message ?? error);
            return {
                error: /authenticate|bad decrypt|Unsupported state|wrong passphrase/i.test(message)
                    ? "口令不对，或者这个包不是本插件封出来的"
                    : message,
            };
        }
    }

    /**
     * Write a previously inspected pack over this state directory. The archive is
     * validated in full before the first byte (see restoreSealed), and a plain
     * rollback copy is taken first so a restore can itself be undone.
     *
     * @param {{ file?: string, passphrase?: string }} options
     */
    async migrateRestore(options) {
        const { openState, restoreSealed } = await import("./backup-crypto.js");
        const file = typeof options?.file === "string" ? options.file.trim() : "";
        const passphrase = typeof options?.passphrase === "string" ? options.passphrase : "";
        if (file === "") return { error: "需要一个 .enc 迁移包文件的路径" };
        if (fs.existsSync(file) === false) return { error: `找不到文件：${file}` };
        let opened;
        try {
            opened = openState(file, { passphrase });
        } catch (error) {
            return { error: String(error?.message ?? error) };
        }
        // Keep a plain rollback copy first. Not having one is not a reason to
        // refuse the restore the operator asked for — it is reported instead.
        let safety = "";
        try {
            const { createBackup } = await import("./backup.js");
            const backup = createBackup(stateDir(), { label: "before-migrate-restore", warn: () => {} });
            safety = typeof backup?.path === "string" ? backup.path : "";
        } catch {
            safety = "";
        }
        try {
            const result = restoreSealed(stateDir(), opened.files, { warn: () => {} });
            return { restored: result.restored, safety, sealedAt: typeof opened.sealedAt === "string" ? opened.sealedAt : "" };
        } catch (error) {
            return { error: String(error?.message ?? error) };
        }
    }

    /** Read or save AGENTS.md in the active workspace. */
    async promptPreview(options) {
        // Startup owns the effective cwd (including profile configuration and
        // fallback). Do not re-read the saved overlay and redirect the editor
        // while the bridge is still running in its original workspace.
        if (typeof this.getWorkspaceDirectory !== "function") {
            throw new RemoteError("workspace-unavailable", "Workspace directory is not available", {});
        }
        const directory = await this.getWorkspaceDirectory();
        const filePath = path.join(directory, "AGENTS.md");
        const action = typeof options?.action === "string" ? options.action : "read";
        if (action === "save") {
            const content = typeof options?.content === "string" ? options.content : "";
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf8");
            return {
                ok: true,
                filePath,
                content,
                chars: content.length,
                updatedAt: Date.now(),
            };
        }
        let content = "";
        try {
            content = fs.readFileSync(filePath, "utf8");
        } catch {
            content = "";
        }
        return {
            ok: true,
            filePath,
            content,
            chars: content.length,
            updatedAt: Date.now(),
        };
    }

    async storage() {
        const live = readSavedConfig();
        return {
            usage: directoryUsage(stateDir()),
            retention: {
                journalDays: Number(live.retentionJournalDays ?? DEFAULT_RETENTION.journalDays),
                auditDays: Number(live.retentionAuditDays ?? DEFAULT_RETENTION.auditDays),
                mediaDays: Number(live.retentionMediaDays ?? DEFAULT_RETENTION.mediaDays),
                exportsDays: Number(live.retentionExportsDays ?? DEFAULT_RETENTION.exportsDays),
                logsDays: Number(live.retentionLogsDays ?? DEFAULT_RETENTION.logsDays),
            },
        };
    }

    /**
     * Process-lifetime counters plus the live queue depth, for the card's stats
     * tab. A restart resets them, which the snapshot says out loud (`startedAt`,
     * `uptimeMs`) so nobody reads a counter as a lifetime total.
     */
    async metrics() {
        const snapshot = typeof this.metricsSnapshot === "function" ? this.metricsSnapshot() : undefined;
        if (snapshot !== undefined) return snapshot;
        return { startedAt: 0, uptimeMs: 0, counters: {}, gauges: {}, pendingOutbox: 0 };
    }

    async stats(options) {
        const opts = options ?? {};
        const daysRaw = Number(opts.days);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 90) : 14;
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        const result = computeStats(stateDir(), { days, accountId });

        const live = readSavedConfig();
        const pending = readOutbox(stateDir()).items.length;
        let connected = false;
        try {
            const status = await this.status();
            connected = Array.isArray(status?.accounts) && status.accounts.some((account) => account?.accountId);
        } catch {
            connected = false;
        }
        const budget = readBudget(stateDir());
        const health = buildHealth({
            connected,
            outboxPending: pending,
            budgetUsed: budget.used,
            budgetLimit: Number(live.backgroundDailyLimit ?? 0),
            retention: {
                journalDays: live.retentionJournalDays,
                auditDays: live.retentionAuditDays,
                mediaDays: live.retentionMediaDays,
            },
        });

        return { ...result, health };
    }

    /**
     * 每个会话用了什么模型、多少 token、折合多少元。
     *
     * 三个数字**都是估算**，卡片上也必须这么说：
     *   - token 由提示词与回复的字符数折算（插件不在模型请求链路上，拿不到真实
     *     usage），所以只会小于账单；
     *   - 元由使用者自己填的单价折算，没填就只显示 token；
     *   - 模型名是「我们请求的那条路由」。
     */
    async usageLedger(options) {
        const opts = options ?? {};
        const live = readSavedConfig();
        const accountId =
            typeof opts.accountId === "string" && opts.accountId !== ""
                ? opts.accountId
                : typeof live.accountId === "string" && live.accountId !== ""
                  ? live.accountId
                  : "";
        const priceInPer1k = Number(live.pricePer1kInputYuan ?? 0);
        const priceOutPer1k = Number(live.pricePer1kOutputYuan ?? 0);
        const rows = conversationRows(stateDir(), accountId, {
            priceInPer1k,
            priceOutPer1k,
        });
        return {
            accountId,
            rows,
            totals: ledgerTotals(rows),
            prices: { priceInPer1k, priceOutPer1k },
        };
    }

    /**
     * What a first-run user still has to do.
     *
     * The card could work this out itself from `status()` plus a few config
     * reads, but the decision "is this installed well enough to use?" belongs in
     * one place that a test can call directly — and the card then only renders.
     */
    async onboarding() {
        const live = readSavedConfig();
        let accounts = [];
        try {
            const status = await this.status();
            accounts = Array.isArray(status?.accounts) ? status.accounts : [];
        } catch {
            accounts = [];
        }
        const hostVersion = detectHostVersion();
        const accountIds = accounts.map((account) => String(account?.accountId ?? "")).filter(Boolean);
        return buildOnboardingChecklist({
            accounts,
            accountCount: accountIds.length,
            hostVersion,
            hostTested: hostStatus(hostVersion).status === "tested",
            allowedSenders: Array.isArray(live.allowedSenders) ? live.allowedSenders : [],
            backupEnabled: live.backupEnabled === true,
        });
    }

    async pause(accountId) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        if (!this.persistAccountPaused(id, true, (m) => logger.warn(m))) {
            throw new RemoteError("registry_write_failed", translate("error.accountPauseWrite", {}, readSavedConfig().locale), {});
        }
        this.onAccountControlChange?.(id);
        return { accountId: id, paused: true };
    }

    /** Undo `pause`: the account is served again from the next pass on. */
    async resume(accountId) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        if (!this.persistAccountPaused(id, false, (m) => logger.warn(m))) {
            throw new RemoteError("registry_write_failed", translate("error.accountResumeWrite", {}, readSavedConfig().locale), {});
        }
        this.onAccountControlChange?.(id);
        return { accountId: id, paused: false };
    }

    /**
     * Rename an account on the card. The raw id is server-assigned and
     * meaningless to an operator; the label is what the card shows instead.
     */
    async label(accountId, text) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        setAccountLabel(id, typeof text === "string" ? text : "", (m) => logger.warn(m));
        return { accountId: id };
    }

    /**
     * Set one account's sender allowlist override.
     *
     * Empty senders clear the override (the global config rules again) — an
     * account-level deny-all would strand the account with no path back, so
     * operators who want silence pause the account instead. Setting values
     * takes effect on the account's NEXT message (the handler resolves the
     * list per bring-up); no reload needed.
     */
    async allowlist(accountId, senders, chats) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        // The card sends one comma/newline-separated string per list (its
        // codec layer only has string codecs); arrays are accepted too.
        const split = (value) => (Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/));
        setAccountAllowlist(id, split(senders), split(chats), (m) => logger.warn(m));
        // The inbound handler reads the allowlist once per bring-up, so saving
        // alone would leave the running loop ruling with the old list. Re-arm
        // now — with the dedup guard forced — so the change acts on the very
        // next message, like pause/resume does.
        this.onAccountControlChange?.(id);
        return { accountId: id };
    }

    /**
     * Note that the server refused the saved session.
     *
     * Called by the host when the poll loop sees `errcode: -14`. A fresh login
     * clears it, because the account is then writable again.
     */
    markSessionExpired(accountId) {
        const id = normalizeAccountId(accountId);
        if (id) this.sessionExpiredAccounts.add(id);
        else this.unscopedSessionExpired = true;
    }

    /** Clear the flag: a completed login means the session is valid again. */
    clearSessionExpired(accountId) {
        const id = normalizeAccountId(accountId);
        if (id) this.sessionExpiredAccounts.delete(id);
        else this.unscopedSessionExpired = false;
    }

    /** Backward-compatible aggregate of all account-scoped expiry flags. */
    get sessionExpired() {
        return this.unscopedSessionExpired || this.sessionExpiredAccounts.size > 0;
    }

    /**
     * Session lines across every Weixin conversation, for the settings card.
     *
     * Read fresh from disk on every call rather than from a cached copy: the
     * card is opened rarely, `/new` and `/use` are typed in WeChat between
     * openings, and a stale list would make the card disagree with what the
     * user just did on their phone. A read failure yields an empty list rather
     * than an error, so a corrupt index degrades the card instead of breaking
     * the settings page.
     *
     * @returns {Promise<{conversations: Array<{conversationId: string, active: string, lines: Array<{sessionId: string, title: string|null, createdAt: string|null}>}>}>}
     */
    async sessions() {
        let store = {};
        try {
            store = new SessionLines({ warn: () => {} }).store ?? {};
        } catch {
            // An unreadable index must not take the settings page down.
        }
        // The card must be able to tell accounts apart, so resolve each store
        // key's account prefix back to a label. Account digests retain the
        // distinction between IDs that have the same readable slug.
        const registry = readRegistry();
        const accountByScope = new Map(
            Object.keys(registry).map((id) => [
                accountScope(id),
                { id, label: typeof registry[id]?.label === "string" ? registry[id].label : null },
            ]),
        );
        const conversations = [];
        for (const [conversationId, entry] of Object.entries(store)) {
            const lines = Array.isArray(entry?.lines) ? entry.lines : [];
            if (lines.length === 0) continue;
            const sep = conversationId.indexOf(":");
            const account = sep > 0 ? accountByScope.get(conversationId.slice(0, sep)) : undefined;
            // Older unscoped entries remain on disk but cannot control a new scoped conversation.
            if (account === undefined) continue;
            conversations.push({
                conversationId,
                conversationLabel: conversationId.slice(sep + 1),
                accountId: account.id,
                accountLabel: account.label,
                active: typeof entry.active === "string" ? entry.active : lines[0].sessionId,
                lines: lines.map((line) => ({
                    sessionId: String(line.sessionId ?? ""),
                    // The card shows its own placeholder for an unnamed line;
                    // null keeps "no title yet" distinct from an empty title.
                    title: typeof line.title === "string" && line.title !== "" ? line.title : null,
                    createdAt: typeof line.createdAt === "string" ? line.createdAt : null,
                })),
            });
        }
        // Most recently used conversation first, so the one the operator is
        // actually talking in is at the top of the card.
        conversations.sort((a, b) => lastUsedAt(store[b.conversationId]) - lastUsedAt(store[a.conversationId]));
        return { conversations };
    }

    /**
     * Point a conversation at one of its session lines.
     *
     * Mirrors the `/use <n>` command so the operator can switch from the card
     * without typing in WeChat. The write goes through the same store the
     * inbound handler reads, so the next message follows the switch without a
     * reload.
     *
     * @param {string} conversationId
     * @param {number} index 1-based position in the conversation's line list
     * @returns {Promise<{switched: true, sessionId: string} | {switched: false, error: string}>}
     */
    async useSession(conversationId, index) {
        const lines = new SessionLines({ warn: () => {} });
        const sessionId = lines.use(String(conversationId ?? ""), Number(index));
        if (sessionId === undefined) {
            // Not `{ok:false}`: the client's `unwrap()` treats any object with an
            // `ok` key as a carrier envelope and would strip this to `undefined`.
            return { switched: false, error: `no session line at position ${index}` };
        }
        return { switched: true, sessionId };
    }

    /**
     * Remove one session line from a conversation, mirroring the card's
     * delete button. Same store the inbound handler reads, so the removal is
     * live without a reload; removing the last line removes the whole
     * conversation entry (the next message re-creates a line — see
     * SessionLines.remove).
     *
     * @param {string} conversationId
     * @param {number} index 1-based position as shown by /list and the card
     * @returns {Promise<{removed: true} | {removed: false, error: string}>}
     */
    async removeSession(conversationId, index) {
        const lines = new SessionLines({ warn: () => {} });
        const active = lines.remove(String(conversationId ?? ""), Number(index));
        if (active === undefined) {
            // Same envelope rule as useSession: no `ok` key on the failure shape.
            return { removed: false, error: `cannot remove session line at position ${index}` };
        }
        return { removed: true };
    }
}

/** Latest `lastUsedAt` in a line entry, for sorting conversations. */
function lastUsedAt(entry) {
    let newest = 0;
    for (const line of Array.isArray(entry?.lines) ? entry.lines : []) {
        const parsed = Date.parse(line?.lastUsedAt ?? line?.createdAt ?? "");
        if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
    }
    return newest;
}

/**
 * Remove abandoned sessions without racing a request that can still confirm.
 * `includeActive` is reserved for an explicit new login attempt; normal status
 * reads leave an in-flight confirmation alone and let its own bounded request
 * settle first.
 */
export function purgeStaleLogins(now = Date.now(), { includeActive = false, includeIdle = false } = {}) {
    for (const [sessionKey, login] of logins) {
        if (!includeActive && login.inFlightPolls > 0) continue;
        if (isPastLoginDeadline(login, now) || (includeIdle && now - login.lastActivityAt >= LOGIN_TTL_MS)) {
            logins.delete(sessionKey);
        }
    }
}

remoteMethods(WeixinLoginController, ["startLogin", "poll", "submitVerifyCode", "cancel", "status", "logout", "sessions", "useSession", "removeSession", "pause", "resume", "label", "allowlist", "journal", "journalExport", "stats", "onboarding", "storage", "metrics", "outbox", "outboxRetry", "outboxDrop", "reminders", "remindCancel", "usageLedger", "migrateSummary", "migrateExport", "migrateInspect", "migrateRestore", "promptPreview"]);
