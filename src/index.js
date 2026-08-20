import { readFileSync } from "node:fs";

export const name = "dsh-plugin-deepseek-balance";
export const inject = ["webServer", "credentials"];

const ROOT = "/deepseek-balance";
const CLIENT_PATH = `${ROOT}/client.js`;
const CLIENT_SOURCE = readFileSync(new URL("./client.js", import.meta.url), "utf8");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function appError(message, status = 502, code = "request_failed", extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function parseBody(value) {
  if (obj(value)) return value;
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function normalizeDeepSeek(payload) {
  return {
    available: payload?.is_available === true,
    balances: (Array.isArray(payload?.balance_infos) ? payload.balance_infos : []).map((row) => ({
      currency: String(row?.currency ?? "CNY"),
      totalBalance: String(row?.total_balance ?? "0"),
      grantedBalance: String(row?.granted_balance ?? "0"),
      toppedUpBalance: String(row?.topped_up_balance ?? "0"),
    })),
  };
}

function provider(file) {
  return String(first(file?.provider, file?.type, "")).trim().toLowerCase().replaceAll("_", "-");
}

function disabled(file) {
  return file?.disabled === true || file?.disabled === 1 || String(file?.disabled).toLowerCase() === "true";
}

function accountId(file) {
  const metadata = obj(file?.metadata), attributes = obj(file?.attributes);
  for (const item of [file, metadata, attributes, obj(file?.id_token), obj(metadata?.id_token), obj(attributes?.id_token)]) {
    const value = first(item?.chatgpt_account_id, item?.chatgptAccountId, item?.account_id, item?.accountId);
    if (value) return String(value);
  }
}

export function quotaWindow(value, label) {
  if (!obj(value)) return;
  const used = Number(first(value.used_percent, value.usedPercent));
  const validUsed = Number.isFinite(used);
  const blocked = first(value.allowed, true) === false || first(value.limit_reached, value.limitReached, false) === true;
  const remainingPercent = blocked ? 0 : validUsed ? Math.max(0, Math.min(100, 100 - used)) : undefined;
  const rawReset = first(value.reset_at, value.resetAt);
  const after = Number(first(value.reset_after_seconds, value.resetAfterSeconds));
  let resetAt;
  if (rawReset) resetAt = new Date(typeof rawReset === "number" && rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset).toISOString();
  else if (Number.isFinite(after)) resetAt = new Date(Date.now() + after * 1000).toISOString();
  return { label, remainingPercent, resetAt };
}

export function quotaLabel(value, fallback) {
  const seconds = Number(first(value?.limit_window_seconds, value?.limitWindowSeconds));
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds >= 4 * 3600 && seconds <= 6 * 3600) return "5 小时额度";
  if (seconds >= 23 * 3600 && seconds <= 25 * 3600) return "日额度";
  if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return "周额度";
  if (seconds >= 27 * 86400 && seconds <= 32 * 86400) return "月额度";
  const hours = seconds / 3600;
  return hours < 48 ? `${Math.round(hours)} 小时额度` : `${Math.round(seconds / 86400)} 天额度`;
}

export function normalizeUsage(payload) {
  const rate = obj(first(payload?.rate_limit, payload?.rateLimit));
  const primary = first(rate?.primary_window, rate?.primaryWindow);
  const secondary = first(rate?.secondary_window, rate?.secondaryWindow);
  return {
    plan: String(first(payload?.plan_type, payload?.planType, "未知套餐")),
    windows: [
      quotaWindow(primary, quotaLabel(primary, "主额度")),
      quotaWindow(secondary, quotaLabel(secondary, "次级额度")),
    ].filter(Boolean),
  };
}

function dateValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function expirationOf(file) {
  const metadata = obj(file?.metadata), attributes = obj(file?.attributes);
  const sources = [file, metadata, attributes, obj(file?.id_token), obj(metadata?.id_token), obj(attributes?.id_token)];
  for (const source of sources) {
    const subscription = obj(source?.subscription);
    const value = first(
      source?.chatgpt_subscription_active_until,
      source?.chatgptSubscriptionActiveUntil,
      source?.subscription_active_until,
      source?.subscriptionActiveUntil,
      subscription?.active_until,
      subscription?.activeUntil,
      subscription?.expires_at,
      subscription?.expiresAt,
    );
    const normalized = dateValue(value);
    if (normalized) return normalized;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw appError("请求内容过大", 413, "invalid_request");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw appError("请求内容不是有效 JSON", 400, "invalid_request"); }
}

export function loopback(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
}

export function sameOrigin(req) {
  const origin = Array.isArray(req.headers?.origin) ? req.headers.origin[0] : req.headers?.origin;
  const host = Array.isArray(req.headers?.host) ? req.headers.host[0] : req.headers?.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function cached(entry, ttlMs, now = Date.now()) {
  return entry && now - entry.storedAt < ttlMs;
}

export function apply(ctx, config = {}) {
  const deepSeekRef = config.apiKeyEnv || "DEEPSEEK_API_KEY";
  const cpaRef = config.cpaManagementKeyEnv || "CPA_MANAGEMENT_KEY";
  const cpaBase = String(config.cpaBaseUrl || "http://127.0.0.1:8317").replace(/\/$/, "");
  const cacheMs = positiveNumber(config.cacheSeconds, 30) * 1000;
  const refreshCooldownMs = positiveNumber(config.refreshCooldownSeconds, 15) * 1000;
  let cpaGuard;
  let deepCache;
  let deepInFlight;
  let deepLastRefresh = 0;
  let cpaCache;
  let cpaInFlight;
  let cpaLastRefresh = 0;
  const accountCaches = new Map();
  const accountInFlight = new Map();
  const accountLastRefresh = new Map();

  async function deepSeek() {
    const credential = await ctx.credentials.resolve(deepSeekRef);
    if (!credential) throw appError(`未配置凭据 ${deepSeekRef}`, 503, "credential_missing");
    const response = await fetch(config.endpoint || "https://api.deepseek.com/user/balance", {
      headers: { Accept: "application/json", Authorization: `Bearer ${credential.value}` },
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw appError(String(payload?.error?.message || `DeepSeek API 返回 ${response.status}`), response.status);
    return normalizeDeepSeek(payload);
  }

  async function getDeepSeek(force = false) {
    const now = Date.now();
    if (deepCache && ((!force && cached(deepCache, cacheMs, now)) || (force && now - deepLastRefresh < refreshCooldownMs))) {
      return deepCache.value;
    }
    if (deepInFlight) return deepInFlight;
    deepInFlight = (async () => {
      const value = { ...(await deepSeek()), checkedAt: new Date().toISOString() };
      const storedAt = Date.now();
      deepCache = { value, storedAt };
      deepLastRefresh = storedAt;
      return value;
    })().finally(() => { deepInFlight = undefined; });
    return deepInFlight;
  }

  async function cpaRequest(path, init, key) {
    const response = await fetch(`${cpaBase}${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(payload?.error || payload?.message || `CPA 返回 ${response.status}`);
      const authFailure = response.status === 401 || response.status === 403 || /banned|failed attempt|management key/i.test(message);
      throw appError(message, response.status, authFailure ? "cpa_auth_blocked" : "cpa_error", { authFailure });
    }
    return payload;
  }

  async function cpaQuota(targetAccount) {
    if (cpaGuard) throw appError(cpaGuard, 429, "cpa_auth_blocked", { guarded: true });
    const credential = await ctx.credentials.resolve(cpaRef);
    if (!credential) {
      const info = await ctx.credentials.describe(cpaRef);
      throw appError("尚未配置 CPA 管理密钥", 503, "credential_missing", { writable: info.writable });
    }
    let listing;
    try { listing = await cpaRequest("/v0/management/auth-files", { method: "GET" }, credential.value); }
    catch (error) {
      if (error?.authFailure) cpaGuard = "已停止继续尝试 CPA 密码。请输入正确管理密钥后再查询。";
      throw error;
    }
    const files = (Array.isArray(listing?.files) ? listing.files : []).filter((file) => {
      if (provider(file) !== "codex" || disabled(file)) return false;
      if (!targetAccount) return true;
      return String(first(file?.auth_index, file?.authIndex, "")) === targetAccount;
    });
    const accounts = await Promise.all(files.map(async (file) => {
      const authIndex = first(file?.auth_index, file?.authIndex);
      const name = String(first(file?.email, file?.name, `Codex 账号 ${authIndex ?? ""}`)).replace(/\.json$/i, "");
      const id = String(authIndex ?? name);
      const expiresAt = expirationOf(file);
      if (authIndex === undefined) return { id, name, expiresAt, error: "缺少 auth_index", windows: [] };
      const header = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": "codex_cli_rs/0.76.0 (Windows; x86_64)" };
      const chatgptAccountId = accountId(file);
      if (chatgptAccountId) header["Chatgpt-Account-Id"] = chatgptAccountId;
      try {
        const result = await cpaRequest("/v0/management/api-call", { method: "POST", body: JSON.stringify({ authIndex, method: "GET", url: CODEX_USAGE_URL, header }) }, credential.value);
        const status = Number(first(result?.status_code, result?.statusCode, 0));
        const body = parseBody(first(result?.body, result?.body_text, result?.bodyText));
        if (status < 200 || status >= 300 || !body) return { id, name, expiresAt, error: status ? `额度接口返回 ${status}` : "额度响应无法解析", windows: [] };
        return { id, name, expiresAt, ...normalizeUsage(body) };
      } catch (error) { return { id, name, expiresAt, error: error instanceof Error ? error.message : String(error), windows: [] }; }
    }));
    if (targetAccount && accounts.length === 0) throw appError("未找到指定的 CPA Codex 账号", 404, "account_not_found");
    return { accounts, checkedAt: new Date().toISOString() };
  }

  function rememberAccounts(value, storedAt) {
    for (const account of value.accounts || []) {
      accountCaches.set(String(account.id), { value: { accounts: [account], checkedAt: value.checkedAt }, storedAt });
    }
  }

  async function getCpa(force = false) {
    const now = Date.now();
    if (cpaCache && ((!force && cached(cpaCache, cacheMs, now)) || (force && now - cpaLastRefresh < refreshCooldownMs))) {
      return cpaCache.value;
    }
    if (cpaInFlight) return cpaInFlight;
    cpaInFlight = (async () => {
      const value = await cpaQuota();
      const storedAt = Date.now();
      cpaCache = { value, storedAt };
      cpaLastRefresh = storedAt;
      rememberAccounts(value, storedAt);
      return value;
    })().finally(() => { cpaInFlight = undefined; });
    return cpaInFlight;
  }

  async function getCpaAccount(account, force = false) {
    const key = String(account);
    const entry = accountCaches.get(key);
    const now = Date.now();
    if (entry && ((!force && cached(entry, cacheMs, now)) || (force && now - (accountLastRefresh.get(key) || 0) < refreshCooldownMs))) {
      return entry.value;
    }
    if (accountInFlight.has(key)) return accountInFlight.get(key);
    const pending = (async () => {
      const value = await cpaQuota(key);
      const storedAt = Date.now();
      accountCaches.set(key, { value, storedAt });
      accountLastRefresh.set(key, storedAt);
      const updated = value.accounts?.[0];
      if (updated && cpaCache) {
        const existing = cpaCache.value.accounts || [];
        const found = existing.some((item) => String(item.id) === key);
        const accounts = found
          ? existing.map((item) => String(item.id) === key ? updated : item)
          : [...existing, updated];
        cpaCache = { value: { ...cpaCache.value, accounts, checkedAt: value.checkedAt }, storedAt };
      }
      return value;
    })().finally(() => { accountInFlight.delete(key); });
    accountInFlight.set(key, pending);
    return pending;
  }

  function fail(res, error) {
    send(res, Number(error?.status) || (error?.name === "TimeoutError" ? 504 : 502), {
      error: error instanceof Error ? error.message : String(error), code: error?.code, writable: error?.writable,
    });
  }

  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({ kind: "exact", path: CLIENT_PATH, handler(_req, res) { send(res, 200, CLIENT_SOURCE, "text/javascript; charset=utf-8"); } }),
      ctx.webServer.register({ kind: "exact", path: `${ROOT}/deepseek`, async handler(req, res) {
        if (req.method !== "GET") return send(res, 405, { error: "仅支持 GET" });
        if (!loopback(req)) return send(res, 403, { error: "仅允许在本机查询余额" });
        try {
          const refresh = new URL(req.url || `${ROOT}/deepseek`, "http://localhost").searchParams.get("refresh") === "1";
          send(res, 200, await getDeepSeek(refresh));
        } catch (e) { fail(res, e); }
      } }),
      ctx.webServer.register({ kind: "exact", path: `${ROOT}/cpa`, async handler(req, res) {
        if (req.method !== "GET") return send(res, 405, { error: "仅支持 GET" });
        if (!loopback(req)) return send(res, 403, { error: "仅允许在本机查询额度" });
        try {
          const url = new URL(req.url || `${ROOT}/cpa`, "http://localhost");
          const account = url.searchParams.get("account") || undefined;
          const refresh = url.searchParams.get("refresh") === "1";
          send(res, 200, account ? await getCpaAccount(account, refresh) : await getCpa(refresh));
        } catch (e) { fail(res, e); }
      } }),
      ctx.webServer.register({ kind: "exact", path: `${ROOT}/cpa-key`, async handler(req, res) {
        if (req.method !== "POST") return send(res, 405, { error: "仅支持 POST" });
        if (!loopback(req)) return send(res, 403, { error: "仅允许在本机设置密钥" });
        if (!sameOrigin(req)) return send(res, 403, { error: "仅允许从当前 WebUI 设置密钥" });
        try {
          const body = await readJson(req), key = typeof body?.key === "string" ? body.key.trim() : "";
          if (!key) return send(res, 400, { error: "CPA 管理密钥不能为空" });
          await ctx.credentials.set(cpaRef, key);
          cpaGuard = undefined;
          cpaCache = undefined;
          cpaLastRefresh = 0;
          accountCaches.clear();
          accountLastRefresh.clear();
          send(res, 200, { saved: true });
        } catch (e) { fail(res, e); }
      } }),
      ctx.webServer.tapIndex((html) => html.includes(CLIENT_PATH) ? html : html.replace("</body>", `<script type="module" src="${CLIENT_PATH}"></script></body>`)),
    ];
    return () => routes.reverse().forEach((dispose) => dispose());
  }, "balance.routes");
}
