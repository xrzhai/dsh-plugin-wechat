window.__ModuleLoader__.load({
	id: "dsh-plugin-wechat",
	// A package-local lazy chunk. The loader's contract (client-modules) is:
	// a package contributes ONE boot-graph entry (its `./client` export), and any
	// source `import()` inside it compiles to `require.async("./client.<name>.js")`
	// — the loader then fetches `/plugins/<id>/client.<name>.js` at the owner's
	// revision, registers it under `<id>/client.<name>.js`, and materializes it on
	// first use. The file name has to match /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
	// or the loader rejects the registration outright.
	//
	// Everything below is the settings card: four primary sections plus the tab shell. It
	// is the bulk of this plugin's UI and it is only reachable from two slots, so
	// it has no business in the bundle the shell loads on every page. The chunk is
	// self-contained by construction — a chunk may not require its own owner (that
	// is a materialization cycle), so the handful of design tokens and helpers it
	// shares with the entry arrive through `createCardModule(deps)` instead.
	chunk: "client.card.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * Build the card against the entry module's design vocabulary.
		 *
		 * @param {object} deps everything the sections used to close over
		 * @returns {{WeixinSettingsCard: Function}}
		 */
		exports.createCardModule = (deps) => {
			const {
				callRemote,
				ctx,
				t,
				createElement,
				C,
				RADIUS,
				panelStyle,
				hintStyle,
				captionStyle,
				panelTitleStyle,
				buttonStyle,
				buttonStyleFor,
				primaryButtonStyle,
				inputStyle,
				pillStyle,
				noticeStyle,
				useLocaleText,
			} = deps;
			const LOGOUT_CONFIRM_PREFIX = "确定退出登录";

			/**
			 * When a saved option actually takes effect.
			 *
			 * The card is a browser chunk and cannot import a Node module, and the
			 * entry module deliberately imports nothing (the test loads it in a
			 * bare sandbox). So the table is copied here — and `config-effect.test.js`
			 * reads this file and fails when the copy drifts from `src/config-effect.js`,
			 * which is itself checked against the schema. Three sources, two guards.
			 */
			const CONFIG_EFFECTS = {
				"enabled": "live",
				"sessionDispatcherEnabled": "live", "sessionDispatcherSenders": "live", "sessionDispatcherTargets": "live", "protectedSessions": "live", "readOnlyPaths": "live",
				"allowedSenders": "live", "allowedChats": "live",
				"chatProvider": "live", "chatModel": "live", "documentExtract": "live",
				"ocrEnabled": "live", "ocrCommand": "live", "ocrTimeoutMs": "live", "ocrMaxChars": "live", "documentTextChars": "live",

				"groupChatEnabled": "live", "groupReplyWhen": "live",

				"pricePer1kInputYuan": "live", "pricePer1kOutputYuan": "live",
				"videoFrames": "live", "locale": "live",
				"toolNotices": "live", "quietHoursEnabled": "live", "quietHoursStart": "live", "quietHoursEnd": "live",
				"senderDailyLimit": "live",
				"retentionJournalDays": "live", "retentionAuditDays": "live", "retentionMediaDays": "live", "retentionExportsDays": "live", "retentionLogsDays": "live",
				"metricsExport": "live", "backupEnabled": "live", "backupKeep": "live",
				"mediaMaxBytes": "live", "backgroundDailyLimit": "live", "busyMessageMode": "live",
				"accountId": "restart", "cwd": "restart", "workspaceTitle": "restart",
				"maxMessageLength": "restart", "sendIntervalMs": "restart", "sendCooldownMs": "restart", "voiceOutbound": "restart", "messageJournal": "restart",
				"sideProvider": "restart", "sideModel": "restart", "groupBotNames": "restart",
				"richContent": "restart", "codeFileThreshold": "restart", "senderRatePerMinute": "restart", "maxQueuedPerConversation": "restart",
				"notifyEnabled": "restart", "notifyPort": "restart", "notifyToken": "restart",
				"webhookUrl": "restart", "webhookSecret": "restart", "webhookTimeoutMs": "restart",
				"toolAudit": "restart", "markdownMode": "restart", "sourceContext": "restart", "readLinks": "restart",
				"progressAfterMs": "restart", "progressToolAfterMs": "restart", "progressEveryMs": "restart", "maxTurnWaitMs": "restart", "eventPollMs": "restart",
				"typingIndicator": "restart", "mediaEnabled": "restart",
				"maxMediaBytes": "restart", "maxInboundMediaBytes": "restart", "cdnBaseUrl": "restart", "asr": "restart",
			};

			/** A saved option's effect, in words the user can act on. */
			function effectLabel(kind) {
				if (kind === "restart") return { label: "重启后生效", labelEn: "takes effect after a restart" };
				if (kind === "login") return { label: "重新登录后生效", labelEn: "takes effect after signing in again" };
				return { label: "保存即生效", labelEn: "takes effect immediately" };
			}

			function effectOf(field) {
				return CONFIG_EFFECTS[field] ?? "live";
			}

			/** Edit the persona file DSH loads when a conversation starts. */
			function PromptSection({ ctx, t }) {
				const [content, setContent] = react.useState("");
				const [savedContent, setSavedContent] = react.useState("");
				const [filePath, setFilePath] = react.useState("");
				const [error, setError] = react.useState("");
				const [message, setMessage] = react.useState("");
				const [busy, setBusy] = react.useState(false);

				const load = react.useCallback(async () => {
					setBusy(true);
					setError("");
					setMessage("");
					try {
						const r = await callRemote(() => ctx.remote.weixin.promptPreview({ action: "read" }));
						const text = String(r?.content ?? "");
						setContent(text);
						setSavedContent(text);
						setFilePath(String(r?.filePath ?? ""));
					} catch (err) {
						setError(String(err?.message ?? err));
					} finally {
						setBusy(false);
					}
				}, [ctx]);

				const save = async () => {
					setBusy(true);
					setError("");
					setMessage("");
					try {
						const r = await callRemote(() => ctx.remote.weixin.promptPreview({ action: "save", content }));
						const text = String(r?.content ?? content);
						setContent(text);
						setSavedContent(text);
						if (r?.filePath) setFilePath(String(r.filePath));
						setMessage(t("Saved. Takes effect on your next WeChat message.", "已保存，下一条微信消息起生效。"));
					} catch (err) {
						setError(String(err?.message ?? err));
					} finally {
						setBusy(false);
					}
				};

				react.useEffect(() => {
					load();
				}, [load]);

				const dirty = content !== savedContent;

				return createElement("div", { style: { ...panelStyle, display: "flex", flexDirection: "column", gap: 12 } },
					createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
						createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
							createElement("span", { style: panelTitleStyle }, t("Persona", "人设")),
							createElement("span", { style: hintStyle },
								t("Big Fish's persona and standing rules. Loaded once for each new topic without adding it to every message; changes take effect from the next reply.",
									"大肥鱼的性格设定与办事规矩。每个新话题加载一次，不挤占日常对话上下文；修改后从下一轮回复起生效。"))),
						createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
							dirty ? createElement("span", { style: pillStyle("warn") }, t("Unsaved changes", "未保存改动")) : null,
							createElement("button", { onClick: load, disabled: busy, style: buttonStyleFor(busy) },
								t("Reload", "重新读取")),
							createElement("button", { onClick: save, disabled: busy || !dirty, style: busy || !dirty ? { ...primaryButtonStyle, opacity: 0.5, cursor: "default" } : primaryButtonStyle },
								busy ? t("Saving…", "正在保存…") : t("Save persona", "保存人设")))),
					filePath ? createElement("div", { style: { ...captionStyle, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 } },
						createElement("span", null, `${t("Path", "文件路径")}：${filePath}`),
						createElement("span", null, `${t("Length", "当前字数")}：${content.length} ${t("chars", "字符")}`)) : null,
					error !== "" ? createElement("p", { style: { ...hintStyle, color: C.danger, margin: 0 } }, error) : null,
					message !== "" ? createElement("p", { style: { ...hintStyle, color: C.success, margin: 0 } }, message) : null,
					createElement("textarea", {
						value: content,
						disabled: busy,
						rows: 22,
						onChange: (event) => {
							setContent(event.target.value);
							setMessage("");
						},
						placeholder: "# AGENTS.md ...",
						style: {
							...inputStyle,
							width: "100%",
							minHeight: 420,
							resize: "vertical",
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
							fontSize: 13,
							lineHeight: "20px",
							padding: 12,
						},
					}));
			}

			//#region design layer
			/**
			 * The card's own stylesheet.
			 *
			 * Inline styles can express layout but not keyframes, hover or focus;
			 * the host's tokens stop at colours. Everything here is additive and
			 * namespaced, and the whole block is guarded because the card is also
			 * imported by the test stub, which has no `document`.
			 */
			const STYLE_ID = "dsh-weixin-card-styles";
			const STYLE_TEXT = `
@keyframes wx-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes wx-pulse { 0%, 100% { opacity: .9; transform: scale(1); } 50% { opacity: .35; transform: scale(.72); } }
.weixin-card-enter { animation: wx-fade-in .22s ease-out both; }
.weixin-tab { transition: background-color .15s ease, color .15s ease, border-color .15s ease, transform .15s ease; }
.weixin-tab:hover { background: rgba(127, 127, 127, .12); }
.weixin-tab:active { transform: scale(.97); }
.weixin-tab:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
.weixin-row { transition: background-color .15s ease, border-color .15s ease; }
.weixin-row:hover { background: rgba(127, 127, 127, .08); }
@media (prefers-reduced-motion: reduce) {
	.weixin-card-enter, 	.weixin-tab, .weixin-row { transition: none !important; }
}
`;
			function ensureCardStyles() {
				if (typeof document === "undefined" || document === null) return;
				if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) return;
				const host = document.head ?? document.body ?? document.documentElement;
				if (host === null || host === undefined || typeof host.appendChild !== "function") return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLE_TEXT;
				host.appendChild(style);
			}

			const reducedMotion = () =>
				typeof window === "object" && window !== null && typeof window.matchMedia === "function"
					? window.matchMedia("(prefers-reduced-motion: reduce)").matches
					: false;

			/** A small rotating arc; the only moving part of a busy state. */
			function PulseDot({ tone = "ok", size = 8 }) {
				const color = tone === "ok" ? C.success : tone === "warn" ? C.warn : tone === "danger" ? C.danger : C.idle;
				return createElement("span", {
						"aria-hidden": "true",
						style: { position: "relative", display: "inline-block", flex: "0 0 auto", width: size, height: size },
					},
					createElement("span", {
						style: {
							position: "absolute",
							inset: 0,
							borderRadius: "50%",
							background: color,
							opacity: 0.28,
							animation: reducedMotion() ? "none" : "wx-pulse 1.9s ease-in-out infinite",
						},
					}),
					createElement("span", {
						style: { position: "absolute", inset: size / 4, borderRadius: "50%", background: color },
					}));
			}

			function Badge({ text, tone = "neutral" }) {
				const tones = {
					ok: [C.successSubtle, C.success],
					warn: [C.warnSubtle, C.warn],
					danger: [C.surfaceSunken, C.danger],
					brand: [C.surfaceSunken, C.brand],
					neutral: [C.surfaceSunken, C.labelSecondary],
				};
				const [background, color] = tones[tone] ?? tones.neutral;
				return createElement("span", {
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "1px 8px",
						borderRadius: RADIUS.pill,
						background,
						color,
						fontSize: 11,
						lineHeight: "18px",
						fontWeight: 500,
						whiteSpace: "nowrap",
					},
				}, text);
			}

			/** Tab glyphs: 15px strokes, no icon font, no dependency. */
			function TabIcon({ id, active }) {
				const stroke = active ? C.brand : C.labelTertiary;
				const common = {
					width: 15,
					height: 15,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke,
					strokeWidth: 1.9,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { flex: "0 0 auto", display: "block" },
				};
				const shapes = {
					account: [createElement("circle", { key: "h", cx: 12, cy: 8, r: 4 }), createElement("path", { key: "b", d: "M4.5 20a7.5 7.5 0 0 1 15 0" })],
					sessions: [createElement("path", { key: "b", d: "M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-5.2A7.5 7.5 0 0 1 11.5 4h2A7.5 7.5 0 0 1 21 11.5Z" })],
					prompt: [
						createElement("path", { key: "a", d: "M5 6h.01M9 6h10M5 12h.01M9 12h10M5 18h.01M9 18h6" }),
					],
					options: [
						createElement("path", { key: "a", d: "M4 7h9M17 7h3" }),
						createElement("circle", { key: "b", cx: 15, cy: 7, r: 2 }),
						createElement("path", { key: "c", d: "M4 17h3M11 17h9" }),
						createElement("circle", { key: "d", cx: 9, cy: 17, r: 2 }),
					],
				};
				return createElement("svg", common, ...(shapes[id] ?? shapes.account));
			}
			//#endregion design layer

		function LoginSection({ ctx, t }) {
			const [state, setState] = react.useState({ phase: "idle" }); // idle|qr|needcode|confirmed|failed|blocked
			const [qrUrl, setQrUrl] = react.useState(null);
			const [qrDataUrl, setQrDataUrl] = react.useState(null);
			const [sessionKey, setSessionKey] = react.useState(null);
			const [code, setCode] = react.useState("");
			const [message, setMessage] = react.useState("");
			const [accounts, setAccounts] = react.useState([]);
			const [statusState, setStatusState] = react.useState("loading");
			const [statusError, setStatusError] = react.useState("");
			const statusRequestRef = react.useRef(0);
			const [sessionExpired, setSessionExpired] = react.useState(false);
			const [loggingOut, setLoggingOut] = react.useState(false);
			const [logoutNotice, setLogoutNotice] = react.useState("");
			const [copied, setCopied] = react.useState(false);
			const pollRef = react.useRef(null);
			const mountedRef = react.useRef(false);
			const startRequestRef = react.useRef(0);
			const startInFlightRef = react.useRef(null);
			// The session key lives in a ref as well as in state: the poll loop is
			// asynchronous, and a closure over the render's `sessionKey` would keep
			// the null the component started with forever.
			const sessionKeyRef = react.useRef(null);

			const stopPolling = react.useCallback(() => {
				sessionKeyRef.current = null;
				if (pollRef.current) {
					clearTimeout(pollRef.current);
					pollRef.current = null;
				}
			}, []);
			const isCurrentPoll = key =>
				mountedRef.current && typeof key === "string" && key !== "" && sessionKeyRef.current === key;

			const refreshStatus = react.useCallback(async () => {
				const request = ++statusRequestRef.current;
				try {
					const s = await callRemote(() => ctx.remote.weixin.status());
					if (request !== statusRequestRef.current) return;
					if (!Array.isArray(s?.accounts)) throw new Error("Invalid account status response");
					setAccounts(s.accounts);
					// `accounts[].sessionExpired` is the scoped source. The aggregate
					// remains supported for older hosts that only returned the legacy
					// top-level boolean.
					setSessionExpired(s?.sessionExpired === true || s.accounts.some(account => account?.sessionExpired === true));
					setStatusState("ready");
					setStatusError("");
				} catch (err) {
					if (request === statusRequestRef.current) {
						setStatusError(err?.code === "registry_unreadable" ? String(err.message ?? "") : "");
						setStatusState("error");
					}
				}
			}, [ctx]);

			// How often the card re-reads its status while it is mounted. The
			// settings page is often left open, and the account state changes
			// elsewhere: another device logs in or out, or the server-side session
			// expires. A status read is cheap but not free, so 15s is the compromise
			// -- fast enough that the card is not visibly stale when the operator
			// looks back at it (and a session expiring is noticed within one tick),
			// slow enough that an idle settings page is not a request per second.
			const STATUS_POLL_MS = 15000;

			react.useEffect(() => {
				mountedRef.current = true;
				refreshStatus();
				// The background refresh is a browser affordance: it exists to notice
				// changes made on another device and it watches the window and the
				// document for the moments the operator returns to the card. A host
				// without them (the tests, any non-browser importer of this bundle)
				// keeps the one-shot read above and nothing else, rather than throwing
				// on a global it never had.
				const win = typeof window === "undefined" ? null : window;
				const doc = typeof document === "undefined" ? null : document;
				const watch = win !== null && doc !== null && typeof win.addEventListener === "function";
				let timer = null;
				let reading = false;

				/**
				 * One status read, or none.
				 *
				 * Skipped rather than queued while a read is in flight: the host can
				 * hold a request open, and a slow answer must not stack the next tick
				 * behind it. Also skipped while a QR login is polling -- that loop
				 * refreshes the status itself on every transition, so a background
				 * read would only race it with the state it is already updating.
				 */
				const read = async () => {
					if (reading || sessionKeyRef.current) return;
					reading = true;
					try {
						await refreshStatus();
					} finally {
						reading = false;
					}
				};

				// Self-scheduling, like the login poll, so a tick can never overlap the
				// next one; `reading` covers a request a focus event started.
				const schedule = () => {
					timer = setTimeout(() => {
						timer = null;
						read();
						schedule();
					}, STATUS_POLL_MS);
				};

				const onFocus = () => read();
				const onVisibility = () => {
					if (doc !== null && doc.visibilityState === "visible") read();
				};

				if (watch) {
					win.addEventListener("focus", onFocus);
					doc.addEventListener("visibilitychange", onVisibility);
					schedule();
				}

				return () => {
					mountedRef.current = false;
					startRequestRef.current += 1;
					if (watch) {
						win.removeEventListener("focus", onFocus);
						doc.removeEventListener("visibilitychange", onVisibility);
					}
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
					// This effect deliberately does not depend on `sessionKey`: doing so
					// would tear down and recreate the whole status watcher on every
					// login transition. The live key is therefore read from its ref.
					const activeSessionKey = sessionKeyRef.current;
					stopPolling();
					if (activeSessionKey) ctx.remote.weixin.cancel(activeSessionKey).catch(() => {});
				};
			}, [refreshStatus, stopPolling]);

			const start = async () => {
				if (startInFlightRef.current) return startInFlightRef.current;
				setMessage("");
				setCopied(false);
				const request = ++startRequestRef.current;
				const task = (async () => {
					try {
						const r = await callRemote(() => ctx.remote.weixin.startLogin());
						if (!mountedRef.current || request !== startRequestRef.current) {
							const lateKey = r?.sessionKey;
							// A shared start can legitimately return the key already selected by a
							// newer request in this component. Only cancel a key this stale result
							// alone owns.
							if (lateKey && lateKey !== sessionKeyRef.current) {
								await ctx.remote.weixin.cancel(lateKey).catch(() => {});
							}
							return;
						}
						if (r?.status === "cancelled") {
							stopPolling();
							setSessionKey(null);
							setQrUrl(null);
							setQrDataUrl(null);
							setState({ phase: "idle" });
							return;
						}
						setQrUrl(r?.qrcodeUrl ?? null);
						setQrDataUrl(r?.qrDataUrl ?? null);
						setSessionKey(r?.sessionKey);
						setState({ phase: "qr" });
						stopPolling();
						sessionKeyRef.current = r?.sessionKey ?? null;
						// The server holds each status request open for ~30s, so this is a
						// self-scheduling loop rather than a fixed interval: the next call is
						// queued only once the previous one has come back. A 1s interval left
						// ~30 requests in flight at once and swallowed every answer -- which is
						// where a scan shows up -- so the card could never leave the QR page.
						const tick = async () => {
							pollRef.current = null;
							const key = sessionKeyRef.current;
							if (!isCurrentPoll(key)) return;
							let next = false;
							try {
								const p = await callRemote(() => ctx.remote.weixin.poll(key));
								if (!isCurrentPoll(key)) return;
								if (p.status === "confirmed") {
									stopPolling();
									setState({ phase: "confirmed" });
									setMessage(p.accountId ? `${t("Bound account", "已绑定账号")}: ${p.accountId}` : "");
									refreshStatus();
								} else if (p.status === "cancelled") {
									// cancel()/logout() removed the host-side session while this request
									// was open. It is terminal; retrying would only produce `no_login`.
									stopPolling();
									setSessionKey(null);
									setState({ phase: "idle" });
									setMessage("");
								} else if (p.status === "need_verifycode") {
									setState({ phase: "needcode" });
									setMessage(p.message ?? "");
									next = true;
								} else if (p.status === "retrying") {
									// A network/HTTP/malformed-response failure is not the same
									// as the server's normal long-poll wait. Keep the QR visible,
									// but tell the operator why it is retrying.
									setState({ phase: "qr" });
									setMessage(p.message ?? "");
									next = true;
								} else if (p.status === "refreshed") {
									setQrUrl(p.qrcodeUrl ?? null);
									setQrDataUrl(p.qrDataUrl ?? null);
									setState({ phase: "qr" });
									next = true;
								} else if (p.status === "failed") {
									stopPolling();
									setState({ phase: "failed" });
									setMessage(p.message ?? "");
									// The host can already hold a credential when a login reports failure,
									// so re-read the real state instead of trusting the message alone.
									refreshStatus();
								} else if (p.status === "alreadyBound") {
									// The bot is still bound on the server but this host no longer holds
									// the token, and only the phone can break that link. It is a dead end
									// until then, so it gets its own state rather than a red caption.
									stopPolling();
									setState({ phase: "blocked" });
									setMessage(p.message ?? "");
									refreshStatus();
								} else if (p.status === "wait" || p.status === "scaned") {
									setState({ phase: "qr" });
									setMessage("");
									next = true;
								} else {
									next = true;
								}
							} catch (err) {
								if (!isCurrentPoll(key)) return;
								// A forgotten session is terminal: the host no longer holds this login,
								// so polling it again can only fail. Anything else is transient.
								if (err?.code === "no_login") {
									stopPolling();
									setState({ phase: "failed" });
									setMessage(t("This login is no longer active. Scan again to log in.", "本次登录已失效，请重新扫码登录。"));
									refreshStatus();
								} else {
									next = true;
								}
							}
							if (next && isCurrentPoll(key)) {
								pollRef.current = setTimeout(tick, 1000);
							}
						};
						pollRef.current = setTimeout(tick, 0);
					} catch (err) {
						if (!mountedRef.current || request !== startRequestRef.current) return;
						setState({ phase: "failed" });
						setMessage(String(err?.message ?? err));
					}
				})();
				startInFlightRef.current = task;
				try {
					await task;
				} finally {
					if (startInFlightRef.current === task) startInFlightRef.current = null;
				}
			};

			const submitCode = async () => {
				if (!sessionKey || !code.trim()) return;
				await callRemote(() => ctx.remote.weixin.submitVerifyCode(sessionKey, code.trim()));
				setCode("");
				setState({ phase: "qr" });
				setMessage("");
			};

			const cancel = async () => {
				stopPolling();
				if (sessionKey) await ctx.remote.weixin.cancel(sessionKey).catch(() => {});
				setState({ phase: "idle" });
				setMessage("");
			};

			/**
			 * Forget the bound account, after asking.
			 *
			 * The confirmation is not ceremony: the credentials are the only copy
			 * of the login, and recovering them means scanning again. It also
			 * names the account, because an operator with more than one bound
			 * account must see which one is about to go.
			 */
			const leaveAccount = async () => {
				const which = accounts.map((a) => a.accountId).join(", ");
				const ok = globalThis.confirm?.(
					t(
						`Log out ${which || "this account"}? Its saved credentials are deleted and you will have to scan the QR code again.`,
						`${LOGOUT_CONFIRM_PREFIX} ${which || "当前账号"}？将删除已保存的登录凭证，需要重新扫码才能再次使用。`,
					),
				);
				if (ok === false) return;
				setLoggingOut(true);
				setLogoutNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.logout(""));
					const removed = Array.isArray(r?.removed) ? r.removed : [];
					if (removed.length === 0) {
						setLogoutNotice(t("No saved account was found to remove.", "没有找到可退出的账号。"));
					} else {
						setLogoutNotice(t(
							"Logged out. Reopen DSH to stop the current WeChat connection; you can scan the QR code again whenever you need it.",
							"已退出登录。重新打开 DSH 后，当前微信连接会停止；需要时可随时重新扫码绑定。",
						));
					}
					await refreshStatus();
				} catch (err) {
					setLogoutNotice(String(err?.message ?? err));
				} finally {
					setLoggingOut(false);
				}
			};

			const copyLink = async () => {
				if (!qrUrl) return;
				try {
					await navigator.clipboard.writeText(qrUrl);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					setMessage(t("Copy failed, please copy manually", "复制失败，请手动复制"));
				}
			};

			// Per-account controls. The card's top line answers "is anything
			// bound?"; these rows answer "is *this* account alive, and what can I
			// do about it" — pause/resume without losing the login, rename to
			// something an operator recognizes, and a per-account logout so a
			// second bound account is not dragged down with the first.
			const [busyAccount, setBusyAccount] = react.useState(null);
			const [accountNotice, setAccountNotice] = react.useState("");
			// Inline edit row state. The desktop shell is an Electron renderer,
			// and Electron does not implement window.prompt — it returns
			// undefined, so a prompt-based editor silently did nothing. The
			// editor therefore lives in the card: an input row under the
			// account being edited, committed by a button instead of a modal.
			const [editing, setEditing] = react.useState(null); // { accountId, kind: "label"|"allowlist", draft }

			const setPausedFor = async (account, paused) => {
				setBusyAccount(account.accountId);
				setAccountNotice("");
				try {
					// Each branch wraps its own call: the envelope unwrap is
					// per-invocation, and a shared wrapper around the ternary
					// would leave the second branch's result unwrapped.
					await (paused
						? callRemote(() => ctx.remote.weixin.pause(account.accountId))
						: callRemote(() => ctx.remote.weixin.resume(account.accountId)));
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			const renameAccount = (account) => {
				setEditing({ accountId: account.accountId, kind: "label", draft: account.label ?? "" });
			};

			const editAllowlist = (account) => {
				const current = (account.allowedSenders ?? []).join(", ");
				setEditing({ accountId: account.accountId, kind: "allowlist", draft: current });
			};

			const submitEditing = async () => {
				if (!editing) return;
				const { accountId, kind, draft } = editing;
				setBusyAccount(accountId);
				setAccountNotice("");
				try {
					if (kind === "label") {
						await callRemote(() => ctx.remote.weixin.label(accountId, draft));
					} else {
						await callRemote(() => ctx.remote.weixin.allowlist(accountId, draft, ""));
					}
					setEditing(null);
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			const logoutOne = async (account) => {
				const ok = globalThis.confirm?.(
					t(
						`Log out ${account.label || account.accountId}? Its saved credentials are deleted and you will have to scan the QR code again.`,
						`${LOGOUT_CONFIRM_PREFIX} ${account.label || account.accountId}？将删除该账号的登录凭证，需要重新扫码才能再次使用。`,
					),
				);
				if (ok === false) return;
				setBusyAccount(account.accountId);
				setAccountNotice("");
				try {
					await callRemote(() => ctx.remote.weixin.logout(account.accountId));
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			// "silent for …" from the registry's lastSeenAt, coarse on purpose:
			// the point is to spot a dead account, not to time anything.
			const seenText = (iso) => {
				if (typeof iso !== "string" || iso === "") return null;
				const ms = Date.now() - Date.parse(iso);
				if (!Number.isFinite(ms) || ms < 0) return null;
				const minutes = Math.floor(ms / 60000);
				if (minutes < 1) return t("active just now", "刚刚有消息");
				if (minutes < 60) return t(`last message ${minutes} min ago`, `${minutes} 分钟前有消息`);
				const hours = Math.floor(minutes / 60);
				if (hours < 24) return t(`last message ${hours} h ago`, `${hours} 小时前有消息`);
				return t(`last message ${Math.floor(hours / 24)} d ago`, `${Math.floor(hours / 24)} 天前有消息`);
			};

			const bound = statusState === "ready" && accounts.length > 0;
			// Expiry is account-scoped: one failed credential must not relabel a
			// healthy second account. The top-level boolean is still honoured for
			// compatibility with older hosts/front-end bundles.
			const expiredAccounts = accounts.filter(account => account?.sessionExpired === true);
			const expiredAccountNames = expiredAccounts
				.map(account => account.label || account.accountId)
				.filter(Boolean)
				.join(", ");
			// One status line: a colored dot for the state, the account as the
			// value. Stating "no account" in grey text made a real state read
			// like absent information, and an expired session looked identical
			// to a healthy one because the token file is complete either way.
			const statusKind = statusState === "error" ? "bad" : statusState === "loading" ? "idle" : sessionExpired ? "bad" : bound ? "ok" : "idle";
			const statusText = statusState === "error"
				? t("Account status unavailable", "无法读取账号状态")
				: statusState === "loading"
				? t("Checking account status…", "正在读取账号状态…")
				: sessionExpired
				? expiredAccounts.length > 0
					? t(`${expiredAccounts.length} of ${accounts.length} sessions expired`, `${accounts.length} 个账号中有 ${expiredAccounts.length} 个登录已过期`)
					: t("Session expired", "登录已过期")
				: bound
					? t("Bound", "已绑定")
					: t("Not logged in", "未登录");
			// The per-account rows are the card's answer to "which account is
			// which, and is it actually receiving": label (or raw id) plus the
			// registry's last message time, then the four controls. Pausing is
			// deliberately not logout — the credential stays, so resuming needs
			// no re-scan.
			const accountRows = bound
				? createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						accounts.map((account) => {
							const busy = busyAccount === account.accountId;
							const registryError = typeof account.registryError === "string" && account.registryError !== "";
							const seen = seenText(account.lastSeenAt);
							return createElement("div", {
									key: account.accountId,
									style: {
										display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
										padding: "7px 10px",
										border: `1px solid ${C.border}`,
										borderRadius: RADIUS.control,
										background: C.surfaceSunken,
									},
								},
								createElement("span", {
									style: { fontSize: 13, fontWeight: 500, color: C.labelPrimary },
								}, account.label || account.accountId),
								account.label ? createElement("span", {
									style: { fontSize: 12, color: C.labelSecondary },
								}, account.accountId) : null,
								registryError ? createElement("span", { role: "alert", style: noticeStyle }, account.registryError) : null,
								account.paused ? createElement("span", { style: pillStyle("idle") }, t("paused", "已暂停")) : null,
								account.sessionExpired === true ? createElement("span", { style: pillStyle("bad") }, t("session expired", "登录已过期")) : null,
								seen ? createElement("span", { style: { fontSize: 12, color: C.labelSecondary } }, seen) : null,
								createElement("span", { style: { flex: 1 } }),
								createElement("button", {
									onClick: () => renameAccount(account),
									disabled: registryError,
									style: buttonStyleFor(registryError),
								}, t("Rename", "改名称")),
								createElement("button", {
									onClick: () => setPausedFor(account, !account.paused),
									disabled: busy || registryError,
									style: buttonStyleFor(busy || registryError),
								}, account.paused
									? t("Resume", "恢复")
									: busy ? t("Pausing…", "正在暂停…") : t("Pause", "暂停")),
								createElement("button", {
									onClick: () => logoutOne(account),
									disabled: busy,
									style: buttonStyleFor(busy),
								}, busy ? t("Logging out…", "正在退出…") : t("Log out", "退出登录")),
								!registryError && editing?.accountId === account.accountId
									? createElement("div", {
											style: { display: "flex", alignItems: "center", gap: 6, flexBasis: "100%" },
										},
										createElement("input", {
											value: editing.draft,
											onChange: (event) => setEditing({ ...editing, draft: event.target.value }),
											placeholder: editing.kind === "allowlist"
												? t("comma-separated sender ids; empty = global list", "逗号分隔的发送者 id；留空 = 用全局白名单")
												: t("e.g. work account", "例如：工作号"),
											style: inputStyle,
										}),
										createElement("button", {
											onClick: () => void submitEditing(),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Save", "保存")),
										createElement("button", {
											onClick: () => setEditing(null),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Cancel", "取消")))
									: null);
						}))
				: null;

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },

				//#region status
				createElement("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							flexWrap: "wrap",
							padding: "10px 12px",
							borderRadius: RADIUS.control,
							border: `1px solid ${statusKind === "ok" ? C.success : statusKind === "warn" ? C.warn : statusKind === "bad" ? C.danger : C.border}`,
							background: statusKind === "ok" ? C.successSubtle : statusKind === "warn" ? C.warnSubtle : C.surfaceSunken,
						},
					},
					createElement(PulseDot, {
						tone: statusKind === "ok" ? "ok" : statusKind === "warn" ? "warn" : statusKind === "bad" ? "danger" : "idle",
					}),
					createElement("span", { style: { fontSize: 14, fontWeight: 600, color: C.labelPrimary } }, statusText),
					bound
						? createElement(Badge, { text: accounts.map((a) => a.accountId).join(", "), tone: "neutral" })
						: null,
					sessionExpired ? createElement(Badge, { text: t("action needed", "需要处理"), tone: "danger" }) : null),
				//#endregion status
				statusState === "error"
					? createElement("div", { role: "alert", style: noticeStyle },
						createElement("span", null, statusError || t(
							"Failed to connect to WeChat service. Retry, or restart DSH if you just upgraded.",
							"微信服务连接失败，请重试；若刚安装或升级插件，请重启 DSH。")),
						createElement("button", { onClick: refreshStatus, style: buttonStyleFor(false) }, t("Retry", "重试")))
					: null,

				// One row per bound account: identity, liveness, controls.
				accountRows,

				accountNotice
					? createElement("div", { style: noticeStyle },
							createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
							createElement("span", null, accountNotice))
					: null,

				// The expiry is the one state where the operator must act, and it
				// cannot be inferred from the account list, so it gets a notice
				// rather than a line of colored text.
				statusState === "ready" && sessionExpired
					? createElement("div", { style: noticeStyle },
							createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
							createElement("span", null,
								expiredAccountNames
									? t(
										`The saved session for ${expiredAccountNames} has expired, so that account is not receiving messages. Scan again to log in.`,
										`${expiredAccountNames} 登录已过期，当前收不到该账号的微信消息。请重新扫码登录。`,
									)
									: t(
										"The saved session has expired, so incoming messages are not being received. Scan again to log in.",
										"登录已过期，当前收不到微信消息。请重新扫码登录。",
									)))
					: null,

				// The scan/relogin button is only for a state the operator must
				// act on: nothing bound yet, or the saved login expired. A bound,
				// healthy account shows no primary button — adding a *second*
				// WeChat account is an advanced, rarely wanted action, so it is
				// not offered in the single-account UI at all.
				(state.phase === "idle" || state.phase === "confirmed" || state.phase === "failed"
					|| state.phase === "blocked") && (!bound || sessionExpired)
					? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							createElement("button", {
								onClick: start,
								disabled: statusState !== "ready",
								style: primaryButtonStyle,
							}, sessionExpired
								? t("Scan again to log in", "重新扫码登录")
								: t("Scan QR code to log in", "扫码登录微信")),
							// Only offered when there is something to forget. A
							// logout is destructive, so it is never the primary
							// button and it asks first.
							bound
								? createElement("button", {
										onClick: leaveAccount,
										disabled: loggingOut,
										style: buttonStyleFor(loggingOut),
									}, loggingOut
										? t("Logging out…", "正在退出…")
										: t("Log out", "退出登录"))
								: null)
					: null,

				logoutNotice
					? createElement("div", { style: hintStyle }, logoutNotice)
					: null,

				state.phase === "qr"
					? createElement("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								gap: 10,
								padding: "15px",
								border: `1px solid ${C.border}`,
								borderRadius: RADIUS.card,
								background: C.surfaceSunken,
							},
						},
							// A QR on a bare background is unreliable to scan: the
							// quiet zone has to be light, and the surrounding panel may
							// be dark.
							createElement("div", {
									style: { padding: 10, borderRadius: RADIUS.control, background: "#fff", lineHeight: 0 },
								},
								qrDataUrl
									? createElement("img", { src: qrDataUrl, alt: "QR", style: { width: 200, height: 200, display: "block" } })
									// `qrUrl` is a LOGIN LINK (https://liteapp.weixin.qq.com/q/…),
									// never an image: putting it in an <img src> renders the
									// browser's broken-image glyph, which is what a Windows user
									// saw instead of a QR code. When there is no image, say so
									// and point at the buttons below rather than showing a
									// torn-page icon.
									: createElement("div", { style: { width: 200, height: 200, display: "grid", placeItems: "center", textAlign: "center", padding: 12, color: C.labelTertiary, fontSize: 12, lineHeight: 1.6, boxSizing: "border-box" } },
											t("No QR image. Open the link below to scan it.", "二维码图片不可用，请点下面的「在浏览器打开」扫码"))),
							createElement("div", { style: hintStyle }, t("Scan with WeChat on your phone", "用手机微信扫码登录")),
							qrUrl
								? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" } },
										createElement("a", {
											href: qrUrl,
											target: "_blank",
											rel: "noopener noreferrer",
											style: { ...buttonStyle, textDecoration: "none" },
										}, t("Open link in browser", "在浏览器打开")),
										createElement("button", { onClick: copyLink, style: buttonStyle },
											copied ? t("Copied", "已复制") : t("Copy link", "复制链接")))
								: null,
							createElement("button", { onClick: cancel, style: buttonStyle }, t("Cancel", "取消")))
					: null,

				state.phase === "needcode"
					? createElement("div", { style: panelStyle },
							createElement("p", { style: hintStyle },
								message || t("Enter the verification code shown on your phone", "请输入手机上显示的验证码")),
							createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
								createElement("input", {
									value: code,
									onChange: (e) => setCode(e.target.value),
									placeholder: "123456",
									inputMode: "numeric",
									style: { ...inputStyle, maxWidth: 160 },
								}),
								createElement("button", { onClick: submitCode, style: primaryButtonStyle }, t("Submit", "提交")),
								createElement("button", { onClick: cancel, style: buttonStyle }, t("Cancel", "取消"))))
					: null,

				state.phase === "blocked" && message
					? createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, message))
					: null,

				message && state.phase !== "needcode" && state.phase !== "blocked"
					? createElement("div", { style: captionStyle }, message)
					: null,
			);
		}

/** Current sessions and their controls. */
		function SessionsSection({ ctx, t }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");

			const load = async () => {
				try {
					// `callRemote` already unwraps the carrier envelope, so `r` is
					// the host's own return value, not `{ok, value}`.
					const r = await callRemote(() => ctx.remote.weixin.sessions());
					setError("");
					setData(Array.isArray(r?.conversations) ? r.conversations : []);
				} catch (e) {
					setError(String(e?.message ?? e));
					setData(null);
				}
			};

			react.useEffect(() => {
				load();
			}, []);

			const pick = async (conversationId, index) => {
				setBusy(true);
				setNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.useSession(conversationId, index));
					if (r?.switched === false) {
						setNotice(r.error || t("Could not switch", "切换失败"));
					} else {
						setNotice(t("Switched. New messages go to this topic.", "已切换，接下来的消息进入这个话题。"));
					}
					await load();
				} catch (e) {
					setNotice(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			const removeOne = async (conversationId, index, lineCount, isActive) => {
				// The card's only destructive session action, so it asks first —
				// same shape as logout. Deleting the line in use is allowed: the
				// store falls back to the first surviving line, and deleting the
				// last line removes the whole conversation entry. A later message
				// recreates the list entry while leaving the host session intact.
				const last = lineCount <= 1;
				const ok = globalThis.confirm?.(
					t(
						last
							? "Remove the last topic? This topic list will be empty for now, but its DSH chat history is kept. Your next WeChat message will create a new topic."
							: isActive
								? "Remove the current topic? It will leave this sidebar, and your next message will go to the first remaining topic. Its DSH chat history is kept, and the other topics are unaffected."
								: "Remove this topic? It will leave this sidebar. Its DSH chat history is kept; the other topics and the one currently in use are unaffected.",
						last
							? "确定移除最后一个话题？这个话题列表会暂时清空，但 DSH 里的聊天记录仍会保留；下次在微信发消息时会自动创建新话题。"
							: isActive
								? "确定移除当前话题？侧栏会移除它，后续消息会进入剩余的第一个话题；DSH 里的聊天记录仍会保留，其他话题不受影响。"
								: "确定移除这个话题？侧栏会移除它；DSH 里的聊天记录仍会保留，其他话题和当前使用中的话题都不受影响。",
					),
				);
				if (ok === false) return;
				setBusy(true);
				setNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.removeSession(conversationId, index + 1));
					if (r?.removed === false) {
						setNotice(r.error || t("Could not delete", "删除失败"));
					} else {
						setNotice(t("Deleted.", "已删除。"));
					}
					await load();
				} catch (e) {
					setNotice(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			if (error) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: panelTitleStyle }, t("Topics", "话题")),
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, error)));
			}
			if (data === null) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: hintStyle }, t("Loading…", "加载中…")));
			}
			if (data.length === 0) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: panelTitleStyle }, t("Topics", "话题")),
					createElement("p", { style: hintStyle },
						t("No topics yet. Send a message in WeChat to start one.",
							"还没有话题。用微信发一条消息就会自动创建一个。")));
			}

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				...data.map((conversation) => createElement("div", {
						key: conversation.conversationId,
						style: panelStyle,
					},
					createElement("p", { style: { ...panelTitleStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						// Tell accounts apart: the registry label (or the raw id)
						// when the conversation is scoped to an account, nothing for
						// a bare key left over from before multi-account support.
						typeof conversation.accountId === "string" && conversation.accountId !== ""
							? createElement("span", { style: pillStyle("ok") },
								typeof conversation.accountLabel === "string" && conversation.accountLabel !== ""
									? conversation.accountLabel
									: conversation.accountId)
							: null,
						createElement("span", null, conversation.conversationLabel ?? conversation.conversationId)),
					createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						...conversation.lines.map((line, index) => {
							const isActive = line.sessionId === conversation.active;
							return createElement("div", {
									key: line.sessionId,
									className: "weixin-row",
									style: {
										display: "flex", alignItems: "center", gap: 9,
										padding: "8px 11px",
										border: `1px solid ${isActive ? C.brand : C.border}`,
										borderRadius: RADIUS.control,
										background: isActive ? C.surface : C.surfaceSunken,
									},
								},
								createElement(PulseDot, { tone: isActive ? "ok" : "idle", size: 7 }),
								createElement("span", {
										style: {
											flex: "1 1 auto", minWidth: 0,
											fontSize: 13, lineHeight: "20px",
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
										},
									},
									`${index + 1}. ${line.title || t("(no messages yet)", "（尚无对话）")}`),
								isActive
									? createElement(Badge, { text: t("in use", "使用中"), tone: "brand" })
									: createElement("span", { style: { flex: "0 0 auto" } },
										createElement("button", {
											onClick: () => pick(conversation.conversationId, index),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Use", "切换"))),
								// Delete is offered on EVERY row, including the one in use:
								// the store falls back to the first surviving line, and
								// deleting the last line removes the whole entry (the
								// next message re-creates one), so no confirm can orphan
								// the conversation.
								createElement("button", {
									onClick: () => void removeOne(conversation.conversationId, index, conversation.lines.length, isActive),
									disabled: busy,
									style: buttonStyleFor(busy),
								}, t("Delete", "删除")));
						})),
					createElement("p", { style: captionStyle },
						t("Send /new in WeChat to start another topic; send /list to see them all.",
							"在微信里发 /new 开新话题，发 /list 查看全部。")))),
				notice
					? createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, notice))
					: null);
		}

		/**
		 * Every configurable option, rendered from what the host reports.
		 *
		 * The form is data-driven on purpose: the host sends the field list
		 * (type, label, default, current value, where that value came from), and
		 * this component renders whatever arrives. Adding an option on the host
		 * therefore makes it editable here with no change to this file.
		 *
		 * Values are held as strings while editing — a text input has no other
		 * type — and the host coerces them, so this component never has to know
		 * whether "1500" is a number, a list, or a JSON blob.
		 */
		function ConfigSection({ ctx, t }) {
			const [groups, setGroups] = react.useState([]);
			const [draft, setDraft] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState("");
			const [error, setError] = react.useState("");
			const [configPath, setConfigPath] = react.useState("");
			const [openGroup, setOpenGroup] = react.useState("");
			// D1: 109 options across 12 groups does not fit in anyone's head.
			// Search matches label, hint, path and current value, because a user
			// looking for "weight" may be typing the key they saw in a doc.
			const [search, setSearch] = react.useState("");
			const [onlyDirty, setOnlyDirty] = react.useState(false);
			// D4: the batch filed on the wire as a JSON string (no array codec).
			const [portable, setPortable] = react.useState("");
			const [portableNotice, setPortableNotice] = react.useState("");
			// The host answers with localized validation messages, so it needs to
			// know which language the card is showing.
			const { lang } = useLocaleText(ctx);
			/**
			 * A Remote failure carries a stable `code` beside its message. The code
			 * is what makes a report actionable — "bad_value" points at the field's
			 * validation — so it is kept visible when the message alone would not
			 * identify the offending input.
			 */
			const messageOf = (err) => {
				const text = String(err?.message ?? err);
				const code = err?.code;
				return code && code !== "unknown" ? `${text} (${code})` : text;
			};

			const ESSENTIAL_PATHS = new Set([
				"enabled",
				"cwd",
				"workspaceTitle",
				"chatProvider",
				"chatModel",
				"sideProvider",
				"sideModel",
				"busyMessageMode",
				"allowedSenders",
				"typingIndicator",
				"sessionDispatcherEnabled",
				"sessionDispatcherSenders",
				"sessionDispatcherTargets",
				"protectedSessions",
				"readOnlyPaths",
				"markdownMode",
				"maxMessageLength",
			]);

			const load = react.useCallback(async () => {
				try {
					setError("");
					const r = await callRemote(() => ctx.remote.weixinConfig.list());
					if (!Array.isArray(r?.groups)) throw new Error(t("Invalid settings response", "无法读取网关配置"));
					const rawGroups = r.groups;
					const filteredGroups = rawGroups
						.map((g) => ({
							...g,
							fields: (g.fields ?? []).filter((f) => ESSENTIAL_PATHS.has(f.path)),
						}))
						.filter((g) => g.fields.length > 0);
					const next = {};
					for (const group of filteredGroups) {
						for (const field of group.fields ?? []) next[field.path] = field.value;
					}
					setGroups(filteredGroups);
					setDraft(next);
					setConfigPath(r?.configFile ?? "");
					return r;
				} catch (err) {
					setError(messageOf(err));
					return undefined;
				}
			}, [ctx]);

			react.useEffect(() => {
				load();
			}, [load]);

			/** Which fields differ from what the host reports as saved. */
			const dirtyPaths = [];
			for (const group of groups) {
				for (const field of group.fields ?? []) {
					if (field.readOnly) continue;
					if (String(draft[field.path] ?? "") !== String(field.value ?? "")) {
						dirtyPaths.push(field.path);
					}
				}
			}

			const save = async () => {
				setBusy(true);
				setMessage("");
				setError("");
				try {
					// Only the changed fields are sent, so two people editing
					// different sections do not overwrite each other's work with
					// stale values they never touched.
					const entries = dirtyPaths.map((path) => ({ path, value: draft[path] ?? "" }));
					if (entries.length === 0) {
						setMessage(t("Nothing to save.", "没有需要保存的改动。"));
						return;
					}
					// The batch travels as a JSON string: the wire has no array
					// codec, so a structured array would be rejected at the gateway.
					await callRemote(() => ctx.remote.weixinConfig.save(JSON.stringify(entries), lang));
					await load();
					setMessage(t("Saved.", "已保存。"));
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			const resetAll = async () => {
				setBusy(true);
				setMessage("");
				setError("");
				try {
					const paths = groups.flatMap((group) =>
						(group.fields ?? []).filter((field) => !field.readOnly && field.source === "saved").map((field) => field.path));
					await callRemote(() => ctx.remote.weixinConfig.reset(JSON.stringify(paths)));
					await load();
					setMessage(t("Reset to defaults.", "已恢复默认值。"));
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			const resetOne = async (path) => {
				setBusy(true);
				setError("");
				try {
					await callRemote(() => ctx.remote.weixinConfig.reset(JSON.stringify([path])));
					await load();
					setMessage("");
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			if (groups.length === 0) {
				return createElement("div", { style: panelStyle },
					createElement("p", { role: error ? "alert" : undefined, style: hintStyle }, error || t("Loading options…", "正在读取配置…")),
					error ? createElement("button", { onClick: load, style: buttonStyleFor(false) }, t("Retry", "重试")) : null);
			}

			const renderField = (field) => {
				const value = draft[field.path] ?? "";
				const changed = String(value) !== String(field.value ?? "");
				const set = (next) => setDraft((current) => ({ ...current, [field.path]: next }));
				// The control is chosen by the type the host declared, so the
				// browser enforces the same shape the host will validate.
				let control;
				if (field.type === "boolean") {
					control = createElement("label", {
							style: { display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 },
						},
						createElement("input", {
							type: "checkbox",
							checked: value === true || value === "true",
							disabled: field.readOnly,
							onChange: (event) => set(event.target.checked),
							style: { width: 15, height: 15, accentColor: C.primaryFill, cursor: "pointer" },
						}),
						createElement("span", { style: { color: C.labelPrimary } },
							value === true || value === "true" ? t("On", "开启") : t("Off", "关闭")));
				} else if (field.type === "enum") {
					control = createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
						...(field.options ?? []).map((option) =>
							createElement("label", {
									key: option.value,
									style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 },
								},
								createElement("input", {
									type: "radio",
									name: `weixin-${field.path}`,
									checked: value === option.value,
									disabled: field.readOnly,
									onChange: () => set(option.value),
									style: { accentColor: C.primaryFill, cursor: "pointer" },
								}),
								createElement("span", {}, t(option.labelEn, option.label)))));
				} else if (field.type === "stringList" || field.type === "text") {
					control = createElement("textarea", {
						value,
						disabled: field.readOnly,
						rows: field.type === "stringList" ? 3 : 4,
						onChange: (event) => set(event.target.value),
						style: { ...inputStyle, flex: "initial", width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: "20px" },
					});
				} else if (field.type === "number") {
					control = createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						createElement("input", {
							type: "number",
							value,
							disabled: field.readOnly,
							min: field.min,
							max: field.max,
							step: field.step,
							onChange: (event) => set(event.target.value),
							style: { ...inputStyle, flex: "0 0 auto", width: 160 },
						}),
						field.unit ? createElement("span", { style: captionStyle }, t(field.unitEn, field.unit)) : null);
				} else {
					control = createElement("input", {
						type: "text",
						value,
						disabled: field.readOnly,
						onChange: (event) => set(event.target.value),
						style: { ...inputStyle, width: "100%" },
					});
				}
				return createElement("div", {
						key: field.path,
						style: { display: "flex", flexDirection: "column", gap: 5, padding: "10px 0", borderTop: `1px solid ${C.border}` },
					},
					createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						createElement("span", { style: { fontSize: 13, fontWeight: 600, color: C.labelPrimary } },
							t(field.labelEn, field.label)),
						// Where the value comes from decides what a reset will
						// do, so it is shown rather than inferred.
						field.source === "saved"
							? createElement("span", { style: { ...captionStyle, padding: "1px 6px", border: `1px solid ${C.border}`, borderRadius: RADIUS.pill } },
									t("saved", "已保存"))
							: field.source === "config"
								? createElement("span", { style: { ...captionStyle, padding: "1px 6px", border: `1px solid ${C.border}`, borderRadius: RADIUS.pill } },
										t("from config", "来自配置"))
								: null,
						field.readOnly
							? createElement("span", { style: captionStyle }, t("(read-only here)", "（此处只读）"))
							: null,
						// D2: "saved" is not "in effect". The badge is the whole point
						// of this row — it is what stops "I changed it and nothing
						// happened" from becoming a bug report.
						!field.readOnly && field.source === "saved"
							? createElement("span", {
									style: {
										...captionStyle, padding: "1px 6px", borderRadius: RADIUS.pill,
										border: `1px solid ${effectOf(field.path) === "live" ? C.border : C.warn}`,
										color: effectOf(field.path) === "live" ? C.labelTertiary : C.warn,
									},
								}, t(effectLabel(effectOf(field.path)).labelEn, effectLabel(effectOf(field.path)).label))
							: null,
						field.source === "saved" && !field.readOnly
							? createElement("button", {
									onClick: () => resetOne(field.path),
									disabled: busy,
									style: { ...buttonStyle, minHeight: 24, padding: "1px 8px", fontSize: 12, marginLeft: "auto" },
								}, t("Reset", "恢复默认"))
							: null),
					control,
					createElement("p", { style: captionStyle }, t(field.hintEn, field.hint)),
					changed
						? createElement("p", { style: { ...captionStyle, color: C.warn } }, t("Not saved yet.", "尚未保存。"))
						: null);
			};

			// D1: the needle is matched case-insensitively against everything a
			// human might remember about an option — its label, its hint, the key
			// they read in a doc, and the value on screen. Matching only labels
			// made "404" (a port inside a hint) unsearchable.
			const needle = search.trim().toLowerCase();
			const matches = (field) => {
				if (needle === "") return true;
				const hay = [field.label, field.labelEn, field.hint, field.hintEn, field.path, String(draft[field.path] ?? field.value ?? "")]
					.join(" ").toLowerCase();
				return hay.includes(needle);
			};
			const visibleGroups = groups.map((group) => {
				const fields = (group.fields ?? []).filter((field) => matches(field)
					&& (onlyDirty === false || dirtyPaths.includes(field.path)));
				return { ...group, fields };
			}).filter((group) => group.fields.length > 0);
			const visibleCount = visibleGroups.reduce((sum, group) => sum + group.fields.length, 0);
			// Searching or filtering without opening a section would show a list
			// of collapsed headers and look broken, so a search opens what it
			// found; picking a section by hand still collapses the others.
			const groupOpen = (name) => (needle !== "" || onlyDirty === true ? true : openGroup === name);

			// D4: a portable batch of the *saved* values, secrets left out. It
			// travels as JSON text so it can go through the same string channel
			// the save batch uses, and so what the user copies is exactly what was
			// validated.
			const startupOnly = Object.entries(CONFIG_EFFECTS).filter(([, kind]) => kind === "restart").map(([field]) => field);
			const portableExport = () => {
				const entries = {};
				for (const group of groups) {
					for (const field of group.fields ?? []) {
						if (field.source !== "saved") continue;
						// Secrets never leave the machine: a config file in a chat
						// message or a screenshot is how tokens leak.
						if (field.secret === true) continue;
						entries[field.path] = field.value;
					}
				}
				setPortable(JSON.stringify(entries, null, 2));
				setPortableNotice(t(
					`Copied ${Object.keys(entries).length} saved option(s). Secrets are never included.${startupOnly.length > 0 ? ` These need a restart: ${startupOnly.join(", ")}.` : ""}`,
					`已导出 ${Object.keys(entries).length} 项已保存配置。密钥项一律不导出。${startupOnly.length > 0 ? ` 其中这些要重启后才生效：${startupOnly.join("、")}。` : ""}`));
			};
			const portableImport = () => {
				let parsed;
				try {
					parsed = JSON.parse(portable);
				} catch {
					setPortableNotice(t("That is not JSON — paste the export as-is.", "这不是合法 JSON——原样粘贴导出的那一块。"));
					return;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					setPortableNotice(t("The export is a JSON object of option name → value.", "导出内容是一个「配置名 → 值」的 JSON 对象。"));
					return;
				}
				// Only fields this build knows and the user may write. An unknown
				// key typed by hand would otherwise sit in the draft looking saved.
				const known = new Set();
				for (const group of groups) for (const field of group.fields ?? []) if (field.readOnly !== true && field.secret !== true) known.add(field.path);
				const next = { ...draft };
				const applied = [];
				const rejected = [];
				for (const [path, value] of Object.entries(parsed)) {
					if (known.has(path) === false) { rejected.push(path); continue; }
					next[path] = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
					applied.push(path);
				}
				setDraft(next);
				setPortableNotice(t(
					`Applied ${applied.length} option(s) to the form — press Save to write them.${rejected.length > 0 ? ` Ignored ${rejected.length} unknown or secret option(s): ${rejected.join(", ")}.` : ""}`,
					`已把 ${applied.length} 项填进表单——点「保存」才会写盘。${rejected.length > 0 ? ` 忽略了 ${rejected.length} 项未知或密钥配置：${rejected.join("、")}。` : ""}`));
			};

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				createElement("p", { style: hintStyle },
					t("Configure remote access, your working directory, and reply delivery. Saved changes survive a restart.",
						"设置远程访问权限、工作目录与回复方式。保存后重启仍保留。")),
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
					createElement("input", {
						value: search,
						onChange: (event) => setSearch(event.target.value),
						placeholder: t("Search options (name, hint, value)", "搜索配置（名称、说明、当前值）"),
						style: { ...inputStyle, flex: "1 1 220px", minWidth: 160 },
					}),
					createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 } },
						createElement("input", {
							type: "checkbox", checked: onlyDirty,
							onChange: (event) => setOnlyDirty(event.target.checked === true),
							style: { width: 15, height: 15, accentColor: C.primaryFill, cursor: "pointer" },
						}),
						createElement("span", null, t(`Only what changed (${dirtyPaths.length})`, `只看已改动（${dirtyPaths.length}）`))),
					createElement("button", { onClick: portableExport, disabled: busy, style: buttonStyleFor(busy) },
						t("Export changed values", "导出已保存配置")),
					createElement("span", { style: captionStyle },
						t(`${visibleCount} of ${groups.reduce((sum, group) => sum + (group.fields ?? []).length, 0)} options shown`,
							`显示 ${visibleCount} / ${groups.reduce((sum, group) => sum + (group.fields ?? []).length, 0)} 项`))),
				portable === ""
					? null
					: createElement("div", { style: { ...panelStyle, display: "flex", flexDirection: "column", gap: 8 } },
						createElement("p", { style: panelTitleStyle }, t("Move options between machines", "把配置搬到另一台机器")),
						createElement("textarea", {
							value: portable,
							rows: 8,
							onChange: (event) => setPortable(event.target.value),
							style: { ...inputStyle, width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical", lineHeight: "18px" },
						}),
						createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							createElement("button", { onClick: portableImport, disabled: busy, style: buttonStyleFor(busy) },
								t("Apply pasted values", "应用粘贴的配置")),
							createElement("button", {
								onClick: () => { setPortable(""); setPortableNotice(""); },
								disabled: busy, style: buttonStyleFor(busy),
							}, t("Close", "收起"))),
						portableNotice === "" ? null : createElement("p", { style: hintStyle }, portableNotice)),
				error ? createElement("p", { style: { ...hintStyle, color: C.danger } }, error) : null,
				message ? createElement("p", { style: { ...hintStyle, color: C.success } }, message) : null,
				...visibleGroups.map((group) => {
					const open = groupOpen(group.group);
					return createElement("div", { key: group.group, style: panelStyle },
						createElement("button", {
								onClick: () => setOpenGroup(open ? "" : group.group),
								style: {
									display: "flex", alignItems: "center", gap: 8, width: "100%",
									appearance: "none", background: "transparent", border: "none",
									padding: 0, cursor: "pointer", font: "inherit", textAlign: "left",
								},
							},
							createElement("span", { style: { color: C.labelTertiary, fontSize: 11 } }, open ? "▾" : "▸"),
							createElement("span", { style: panelTitleStyle }, t(group.groupEn, group.group)),
							createElement("span", { style: { ...captionStyle, marginLeft: "auto" } },
								`${(group.fields ?? []).length}`)),
						open ? createElement("div", {}, ...(group.fields ?? []).map(renderField)) : null);
				}),
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
					createElement("button", {
						onClick: save,
						disabled: busy || dirtyPaths.length === 0,
						style: dirtyPaths.length === 0 || busy ? buttonStyleFor(true) : primaryButtonStyle,
					}, busy ? t("Saving…", "保存中…") : t("Save", "保存")),
					createElement("button", { onClick: resetAll, disabled: busy, style: buttonStyleFor(busy) },
						t("Reset all", "全部恢复默认")),
					dirtyPaths.length > 0
						? createElement("span", { style: captionStyle },
								t(`${dirtyPaths.length} unsaved change(s)`, `${dirtyPaths.length} 项未保存`))
						: null),
				configPath
					? createElement("p", { style: captionStyle }, t("Stored in: ", "保存在："), configPath)
					: null);
		}

			function WeixinSettingsCard() {
				// A section heading sits outside its panel so the panel edge
				// reads as the group boundary; an icon-free heading at 14/600
				// matches the host's own settings sections.
				const section = (title, body) =>
					createElement("section", { style: { display: "flex", flexDirection: "column", gap: 8 } },
						createElement("h3", {
							style: { margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: C.labelPrimary },
						}, title),
						body);
				const [tab, setTab] = react.useState("account");
				// Beginner surface: only 微信账号 + 人设 are shown. The ops pages
				// (会话 / 网关配置) live behind 高级 — one click away for whoever
				// needs them, out of sight for a first-time user.
				const [advanced, setAdvanced] = react.useState(false);
				const TABS = [
					{ id: "account", label: t("WeChat Account", "微信账号"), body: createElement(LoginSection, { ctx, t }) },
					{ id: "prompt", label: t("Persona", "人设"), body: createElement(PromptSection, { ctx, t }) },
					{ id: "sessions", label: t("Topics", "话题"), body: createElement(SessionsSection, { ctx, t }), advanced: true },
					{ id: "options", label: t("Gateway Options", "网关配置"), body: createElement(ConfigSection, { ctx, t }), advanced: true },
				];
				const visibleTabs = TABS.filter((entry) => advanced || !entry.advanced);
				const current = visibleTabs.find((entry) => entry.id === tab) ?? visibleTabs[0];
				const onTabKey = (event) => {
					const index = visibleTabs.findIndex((entry) => entry.id === current?.id);
					if (event.key === "ArrowRight") {
						event.preventDefault();
						setTab(visibleTabs[(index + 1) % visibleTabs.length].id);
					} else if (event.key === "ArrowLeft") {
						event.preventDefault();
						setTab(visibleTabs[(index + visibleTabs.length - 1) % visibleTabs.length].id);
					}
				};
				const toggleAdvanced = () => {
					setAdvanced((open) => {
						const next = !open;
						if (!next && current?.advanced) setTab("account");
						return next;
					});
				};
				ensureCardStyles();
				return createElement("div", {
						style: { display: "flex", flexDirection: "column", gap: 16, color: C.labelPrimary },
					},
					createElement("div", {
							role: "tablist",
							className: "weixin-settings-tabbar",
							onKeyDown: onTabKey,
							style: {
								display: "flex",
								gap: 4,
								padding: "0 2px",
								borderBottom: `1px solid ${C.border}`,
								overflowX: "auto",
							},
						},
						...visibleTabs.map((entry) => {
							const active = entry.id === current?.id;
							return createElement("button", {
									key: entry.id,
									role: "tab",
									"aria-selected": active,
									tabIndex: active ? 0 : -1,
									onClick: () => setTab(entry.id),
									className: "weixin-tab",
									style: {
										appearance: "none",
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										background: active ? C.surfaceSunken : "transparent",
										border: "none",
										borderBottom: `2px solid ${active ? C.brand : "transparent"}`,
										borderRadius: `${RADIUS.control}px ${RADIUS.control}px 0 0`,
										color: active ? C.labelPrimary : C.labelTertiary,
										fontSize: 13,
										lineHeight: "20px",
										fontWeight: active ? 600 : 400,
										padding: "9px 11px",
										cursor: "pointer",
										whiteSpace: "nowrap",
									},
								},
								createElement(TabIcon, { id: entry.id, active }),
								entry.label);
						}),
						createElement("button", {
								type: "button",
								onClick: toggleAdvanced,
								"aria-expanded": advanced,
								style: {
									appearance: "none",
									flex: "0 0 auto",
									marginLeft: "auto",
									background: "transparent",
									border: "none",
									color: C.labelTertiary,
									fontSize: 12,
									lineHeight: "20px",
									padding: "9px 6px",
									cursor: "pointer",
									whiteSpace: "nowrap",
								},
							}, advanced ? t("Hide advanced ▴", "收起高级 ▴") : t("Advanced ▾", "高级 ▾"))),
					createElement("div", {
							key: current?.id ?? "empty",
							className: "weixin-card-enter",
							style: { display: "flex", flexDirection: "column" },
						},
						section(current?.label ?? "", current?.body)));
			}
			return { WeixinSettingsCard };
		};
		return module.exports;
	},
});
