import test from "node:test";
import assert from "node:assert/strict";

import {
  apply,
  expirationOf,
  loopback,
  normalizeUsage,
  quotaLabel,
  quotaWindow,
  sameOrigin,
} from "../src/index.js";

function responseCapture() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function pluginRoutes(config = {}) {
  const routes = new Map();
  const ctx = {
    credentials: {
      async resolve() { return { value: "test-only-key" }; },
      async describe() { return { writable: true }; },
      async set() {},
    },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => {}; },
      tapIndex() { return () => {}; },
    },
    effect(start) { start(); },
  };
  apply(ctx, config);
  return routes;
}

test("额度窗口按实际秒数识别", () => {
  assert.equal(quotaLabel({ limit_window_seconds: 5 * 3600 }, "主额度"), "5 小时额度");
  assert.equal(quotaLabel({ limit_window_seconds: 604800 }, "主额度"), "周额度");
  assert.equal(quotaLabel({ limit_window_seconds: 30 * 86400 }, "主额度"), "月额度");
});

test("周额度归一化为剩余百分比", () => {
  const usage = normalizeUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        limit_window_seconds: 604800,
        used_percent: 23,
        reset_at: 1_800_000_000,
      },
    },
  });

  assert.equal(usage.plan, "plus");
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].label, "周额度");
  assert.equal(usage.windows[0].remainingPercent, 77);
  assert.equal(usage.windows[0].resetAt, "2027-01-15T08:00:00.000Z");
});

test("非法重置时间不会丢掉有效额度", () => {
  const quota = quotaWindow({ used_percent: 25, reset_at: "not-a-date" }, "周额度");
  assert.equal(quota.remainingPercent, 75);
  assert.equal(quota.resetAt, undefined);
});

test("从不同 CPA 字段解析订阅到期时间", () => {
  assert.equal(
    expirationOf({ metadata: { id_token: { subscription_active_until: 1_800_000_000 } } }),
    "2027-01-15T08:00:00.000Z",
  );
  assert.equal(
    expirationOf({ attributes: { subscription: { expiresAt: "2027-06-01T00:00:00Z" } } }),
    "2027-06-01T00:00:00.000Z",
  );
});

test("仅识别本机回环地址", () => {
  assert.equal(loopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(loopback({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(loopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(loopback({ socket: { remoteAddress: "192.168.1.10" } }), false);
});

test("密钥写入要求请求来源与 WebUI 同源", () => {
  assert.equal(sameOrigin({ headers: { origin: "http://127.0.0.1:2025", host: "127.0.0.1:2025" } }), true);
  assert.equal(sameOrigin({ headers: { origin: "https://example.com", host: "127.0.0.1:2025" } }), false);
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:2025" } }), false);
});

test("远程地址无法调用余额接口", async () => {
  const route = pluginRoutes().get("/deepseek-balance/deepseek");
  const res = responseCapture();
  await route({ method: "GET", url: "/deepseek-balance/deepseek", socket: { remoteAddress: "192.168.1.10" } }, res);
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error, /本机/);
});

test("普通请求使用缓存，refresh=1 可强制更新", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: String(calls) }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const route = pluginRoutes({ cacheSeconds: 30, refreshCooldownSeconds: 0 }).get("/deepseek-balance/deepseek");
    const request = (url) => ({ method: "GET", url, socket: { remoteAddress: "127.0.0.1" } });
    const first = responseCapture(), second = responseCapture(), refreshed = responseCapture();
    await route(request("/deepseek-balance/deepseek"), first);
    await route(request("/deepseek-balance/deepseek"), second);
    await route(request("/deepseek-balance/deepseek?refresh=1"), refreshed);

    assert.equal(calls, 2);
    assert.equal(JSON.parse(first.body).balances[0].totalBalance, "1");
    assert.equal(JSON.parse(second.body).balances[0].totalBalance, "1");
    assert.equal(JSON.parse(refreshed.body).balances[0].totalBalance, "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("单账号刷新不会延长全量 CPA 缓存", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  let listingCalls = 0;
  Date.now = () => now;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v0/management/auth-files")) {
      listingCalls += 1;
      return new Response(JSON.stringify({
        files: [
          { provider: "codex", auth_index: "a", email: "a@example.invalid" },
          { provider: "codex", auth_index: "b", email: "b@example.invalid" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const call = JSON.parse(init.body);
    return new Response(JSON.stringify({
      status_code: 200,
      body: JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { limit_window_seconds: 604800, used_percent: call.authIndex === "a" ? 10 : 20 },
        },
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const route = pluginRoutes({ cacheSeconds: 30, refreshCooldownSeconds: 0 }).get("/deepseek-balance/cpa");
    const request = (url) => ({ method: "GET", url, socket: { remoteAddress: "127.0.0.1" } });

    await route(request("/deepseek-balance/cpa"), responseCapture());
    now = 32_000;
    await route(request("/deepseek-balance/cpa?account=a&refresh=1"), responseCapture());
    now = 32_001;
    await route(request("/deepseek-balance/cpa"), responseCapture());

    assert.equal(listingCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("重复认证错误只保留一个 CPA 密钥表单", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { readyState: "loading", addEventListener() {} };

  try {
    const { clearKeyForms } = await import("../src/client.js");
    const removed = [];
    const nodes = [
      { remove() { removed.push("first"); } },
      { remove() { removed.push("second"); } },
    ];
    const container = {
      querySelectorAll(selector) {
        assert.equal(selector, ":scope > .key-box");
        return nodes;
      },
    };

    clearKeyForms(container);
    assert.deepEqual(removed, ["first", "second"]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
