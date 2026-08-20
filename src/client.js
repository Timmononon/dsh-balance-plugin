const ROOT = "/deepseek-balance";
const HOST_ID = "dsh-balance-host";

const el = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

async function request(path, options) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { Accept: "application/json", ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), {
      code: data.code,
      status: response.status,
      writable: data.writable,
    });
  }
  return data;
}

function money(value, currency) {
  const amount = Number(value);
  try {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function smallButton(label, title = label) {
  const button = el("button", "mini-button");
  button.type = "button";
  button.title = title;
  decorateRefresh(button, label);
  return button;
}

function decorateRefresh(button, label) {
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.5 6.5L20 11"/><path d="M17.9 15A7 7 0 0 1 5.5 17.5L4 13"/></svg><span></span>';
  button.querySelector("span").textContent = label;
}

function showError(container, error) {
  container.replaceChildren(el("div", "error-box", error instanceof Error ? error.message : String(error)));
}

function showStale(container, error) {
  container.querySelector(":scope > .stale-notice")?.remove();
  const message = error instanceof Error ? error.message : String(error);
  container.appendChild(el("div", "stale-notice", `更新失败，保留上次数据：${message}`));
}

export function clearKeyForms(container) {
  for (const node of container.querySelectorAll(":scope > .key-box")) node.remove();
}

function renderDeepSeek(container, data) {
  container.replaceChildren();
  for (const item of data.balances || []) {
    const card = el("article", "balance-card");
    const main = el("div", "balance-main");
    main.append(el("span", "currency", item.currency), el("strong", "amount", money(item.totalBalance, item.currency)));
    const details = el("div", "balance-details");
    details.append(el("span", "", `赠送 ${money(item.grantedBalance, item.currency)}`), el("span", "", `充值 ${money(item.toppedUpBalance, item.currency)}`));
    card.append(main, details);
    container.appendChild(card);
  }
  if (!data.balances?.length) container.appendChild(el("div", "empty", "没有余额条目"));
}

function quotaLine(quota) {
  const row = el("div", "quota-row");
  const top = el("div", "quota-top");
  const known = Number.isFinite(quota.remainingPercent);
  const percent = known ? quota.remainingPercent : 0;
  top.append(el("span", "quota-name", quota.label), el("strong", "quota-percent", known ? `${percent.toFixed(0)}%` : "--"));
  const track = el("div", "track"), fill = el("div", "fill");
  fill.style.width = `${percent}%`;
  if (percent <= 20) fill.classList.add("low");
  track.appendChild(fill);
  row.append(top, track);
  if (quota.resetAt) row.appendChild(el("div", "reset", `重置 ${new Date(quota.resetAt).toLocaleString("zh-CN")}`));
  return row;
}

function accountCard(account, onRefresh) {
  const card = el("article", "account-card");
  card.dataset.accountId = account.id;
  const header = el("div", "account-header");
  const identity = el("div", "identity");
  const meta = el("div", "identity-meta");
  meta.appendChild(el("span", "plan", account.plan || "未知套餐"));
  meta.appendChild(el("span", "expires", account.expiresAt ? `到期 ${new Date(account.expiresAt).toLocaleString("zh-CN")}` : "到期时间未知"));
  identity.append(el("strong", "account-name", account.name), meta);
  const refresh = smallButton("刷新", `刷新 ${account.name}`);
  refresh.addEventListener("click", () => onRefresh(account.id, refresh));
  header.append(identity, refresh);
  card.appendChild(header);
  if (account.error) card.appendChild(el("div", "inline-error", account.error));
  else if (!account.windows?.length) card.appendChild(el("div", "empty", "没有可显示的额度窗口"));
  else account.windows.forEach((quota) => card.appendChild(quotaLine(quota)));
  return card;
}

function keyForm(onSaved) {
  const box = el("div", "key-box");
  box.appendChild(el("div", "key-title", "更新 CPA 管理密钥"));
  const form = el("form", "key-form");
  const input = document.createElement("input");
  input.type = "password";
  input.required = true;
  input.autocomplete = "current-password";
  input.placeholder = "管理密钥";
  const button = smallButton("保存", "保存 CPA 管理密钥");
  button.type = "submit";
  const message = el("div", "form-message");
  form.append(input, button);
  box.append(form, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.textContent = "保存中…";
    try {
      await request(`${ROOT}/cpa-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input.value }),
      });
      input.value = "";
      message.textContent = "已保存";
      await onSaved();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
  return box;
}

function mount() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, { position: "fixed", right: "18px", bottom: "18px", zIndex: "2147483000" });
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input { font: inherit; }
      .wrap { font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
      .trigger { box-sizing:border-box; cursor:pointer; width:auto; height:38px; color:#171717; background:#fff; border:1px solid #dedede; border-radius:12px; display:flex; align-items:center; gap:7px; margin:0; padding:0 13px; box-shadow:0 8px 24px rgba(0,0,0,.12); font-size:13px; font-weight:600; line-height:20px; }
      .trigger:hover { background:#f2f2f2; }
      .trigger svg { width:17px; height:17px; flex:none; stroke:currentColor; }
      .panel { display:none; position:fixed; inset:auto; z-index:2147483001; width:min(430px,calc(100vw - 24px)); max-height:500px; margin:0; padding:0; overflow:hidden; color:#171717; background:#fff; border:1px solid #dedede; border-radius:16px; box-shadow:0 16px 48px rgba(0,0,0,.18); flex-direction:column; transform-origin:bottom right; }
      .panel:popover-open, .panel.open { display:flex; }
      .panel-header { flex:none; display:flex; align-items:center; justify-content:space-between; min-height:50px; padding:11px 13px 10px 16px; border-bottom:1px solid #ececec; }
      .panel-title { font-size:15px; font-weight:700; letter-spacing:-.01em; }
      .header-actions { display:flex; align-items:center; gap:6px; }
      .close { width:26px; height:26px; border:0; border-radius:8px; color:#555; background:transparent; cursor:pointer; font-size:18px; line-height:1; }
      .close:hover { background:#ededed; }
      .content { min-height:0; overflow:auto; padding:14px 16px 16px; }
      .section + .section { margin-top:15px; }
      .section-heading { display:flex; align-items:center; justify-content:space-between; min-height:26px; margin-bottom:8px; }
      .section-title { color:#555; font-size:11px; font-weight:700; letter-spacing:.08em; }
      .section-actions { display:flex; gap:5px; }
      .mini-button { min-width:0; height:28px; padding:0 10px; border:0; border-radius:9px; color:#171717; background:#edeef0; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:5px; font-size:10px; font-weight:500; line-height:28px; white-space:nowrap; transition:background .14s ease,transform .14s ease; }
      .mini-button svg { width:13px; height:13px; flex:none; }
      .mini-button:hover { background:#e1e2e4; }
      .mini-button:active { transform:scale(.98); }
      .mini-button:disabled { opacity:.45; cursor:default; }
      .section-body { display:grid; gap:8px; }
      .balance-card { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; min-height:68px; padding:13px; border:1px solid #e3e3e3; border-radius:12px; background:#fafafa; }
      .balance-main { display:grid; gap:4px; }
      .currency { color:#777; font-size:10px; font-weight:600; }
      .amount { color:#111; font-size:22px; line-height:1.15; letter-spacing:-.03em; }
      .balance-details { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px 14px; color:#777; font-size:10px; }
      .account-card { padding:12px 13px; border:1px solid #e3e3e3; border-radius:12px; background:#fff; }
      .account-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
      .identity { display:grid; gap:6px; min-width:0; }
      .identity-meta { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px; }
      .account-name { min-width:0; overflow:hidden; text-overflow:ellipsis; color:#222; font-size:14px; line-height:1.25; white-space:nowrap; }
      .plan { flex:none; padding:2px 7px; border:1px solid #dedede; border-radius:999px; color:#555; font-size:10px; line-height:15px; text-transform:lowercase; }
      .expires { color:#777; font-size:10px; }
      .quota-row + .quota-row { margin-top:11px; }
      .quota-top { display:flex; align-items:center; justify-content:space-between; gap:12px; color:#555; font-size:12px; }
      .quota-percent { color:#222; font-size:12px; }
      .track { height:6px; margin-top:6px; overflow:hidden; border-radius:99px; background:#e8e8e8; }
      .fill { height:100%; border-radius:inherit; background:#222; transition:width .25s ease; }
      .fill.low { background:#777; }
      .reset { margin-top:5px; color:#888; font-size:10px; text-align:right; }
      .empty { padding:12px; color:#777; font-size:11px; text-align:center; }
      .loading { opacity:.55; }
      .error-box, .inline-error, .stale-notice { padding:10px 12px; border:1px solid #d9d9d9; border-radius:10px; color:#444; background:#f7f7f7; font-size:10px; line-height:1.5; }
      .stale-notice { border-style:dashed; color:#666; }
      .key-box { padding:11px 12px; border:1px dashed #cfcfcf; border-radius:10px; background:#fafafa; }
      .key-title { margin-bottom:7px; color:#555; font-size:10px; font-weight:600; }
      .key-form { display:flex; gap:6px; }
      .key-form input { min-width:0; flex:1; height:28px; padding:0 8px; border:1px solid #d2d2d2; border-radius:7px; color:#222; background:#fff; font-size:10px; outline:none; }
      .key-form input:focus { border-color:#777; }
      .form-message { margin-top:5px; color:#777; font-size:9px; }
      .footer { flex:none; padding:8px 20px 10px; color:#999; border-top:1px solid #f0f0f0; font-size:8px; text-align:right; }
      @media (prefers-color-scheme:dark) {
        .panel { color:#f2f2f2; background:#1d1d1d; border-color:#3c3c3c; box-shadow:0 24px 70px rgba(0,0,0,.5); }
        .panel-header { border-color:#333; } .close { color:#ccc; } .close:hover { background:#333; }
        .mini-button { color:#eee; background:#373737; } .mini-button:hover { background:#454545; }
        .section-title,.quota-top,.balance-details,.currency { color:#aaa; }
        .balance-card,.account-card { background:#232323; border-color:#3b3b3b; }
        .amount,.account-name,.quota-percent { color:#f3f3f3; } .plan { color:#bbb; border-color:#505050; }
        .track { background:#454545; } .fill { background:#f0f0f0; } .fill.low { background:#999; }
        .error-box,.inline-error,.stale-notice,.key-box { color:#ccc; background:#252525; border-color:#484848; }
        .key-form input { color:#eee; background:#191919; border-color:#4c4c4c; } .footer { border-color:#333; }
      }
      @media (prefers-color-scheme:dark) { .trigger { color:#eee; background:#252525; border-color:#444; } .trigger:hover { background:#333; } }
      @media (max-width:480px) { .panel { width:calc(100vw - 20px); border-radius:14px; } .content { padding:12px; } .balance-card { align-items:flex-start; flex-direction:column; gap:8px; } .balance-details { justify-content:flex-start; } }
    </style>
    <div class="wrap">
      <button class="trigger" type="button" aria-haspopup="dialog" aria-expanded="false" title="余额">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h12"/><path d="M16 12h4v4h-4a2 2 0 0 1 0-4Z"/></svg>
        <span class="trigger-label">余额</span>
      </button>
      <div class="panel" popover="manual" role="dialog" aria-label="余额">
          <header class="panel-header"><div class="panel-title">余额</div><div class="header-actions"><button class="mini-button refresh-all" type="button">刷新全部</button></div></header>
          <main class="content">
            <section class="section"><div class="section-heading"><div class="section-title">DEEPSEEK</div><div class="section-actions"><button class="mini-button refresh-deepseek" type="button">刷新</button></div></div><div class="section-body deepseek"><div class="empty">等待查询</div></div></section>
            <section class="section"><div class="section-heading"><div class="section-title">CPA · CODEX</div><div class="section-actions"><button class="mini-button refresh-cpa" type="button">刷新全部账号</button></div></div><div class="section-body cpa"><div class="empty">等待查询</div></div></section>
          </main>
          <footer class="footer"></footer>
      </div>
    </div>`;

  const trigger = root.querySelector(".trigger"), panel = root.querySelector(".panel");
  const refreshAll = root.querySelector(".refresh-all"), refreshDeep = root.querySelector(".refresh-deepseek"), refreshCpa = root.querySelector(".refresh-cpa");
  const deep = root.querySelector(".deepseek"), cpa = root.querySelector(".cpa"), footer = root.querySelector(".footer");
  let loaded = false, accounts = [], hasDeepData = false, hasCpaData = false;
  let lastCheckedAt, desiredOpen = false, motion, motionToken = 0, positionTimer;
  decorateRefresh(refreshAll, "刷新全部");
  decorateRefresh(refreshDeep, "刷新");
  decorateRefresh(refreshCpa, "刷新全部账号");

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function obstacleAt(candidate) {
    const points = [
      [candidate.left + candidate.width / 2, candidate.top + candidate.height / 2],
      [candidate.left + 4, candidate.top + 4],
      [candidate.right - 4, candidate.top + 4],
      [candidate.left + 4, candidate.bottom - 4],
      [candidate.right - 4, candidate.bottom - 4],
    ];
    const found = new Set();
    for (const [x, y] of points) {
      for (const node of document.elementsFromPoint(x, y)) {
        const interactive = node.closest?.('button,a,[role="button"]');
        if (!interactive || found.has(interactive) || interactive.getRootNode() === root || interactive === host) continue;
        const style = getComputedStyle(interactive), rect = interactive.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0) continue;
        if (intersects(candidate, rect)) {
          found.add(interactive);
          return rect;
        }
      }
    }
  }

  function detectSafeButtonPosition() {
    const triggerRect = trigger.getBoundingClientRect();
    const width = triggerRect.width || 78, height = triggerRect.height || 38;
    let bottom = 18;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const right = window.innerWidth - 18;
      const candidate = { left: right - width, right, top: window.innerHeight - bottom - height, bottom: window.innerHeight - bottom, width, height };
      const obstacle = obstacleAt(candidate);
      if (!obstacle) break;
      bottom = Math.max(bottom + 8, window.innerHeight - obstacle.top + 8);
      if (bottom + height > window.innerHeight - 12) { bottom = 18; break; }
    }
    host.style.bottom = `${bottom}px`;
    if (panelIsOpen()) positionPanel();
  }

  function schedulePositionCheck() {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(detectSafeButtonPosition, 120);
  }

  requestAnimationFrame(detectSafeButtonPosition);
  new MutationObserver(schedulePositionCheck).observe(document.body, { childList: true, subtree: true });

  function updateFooter(data) {
    const checkedAt = Date.parse(data?.checkedAt);
    if (Number.isFinite(checkedAt)) lastCheckedAt = Math.max(lastCheckedAt || 0, checkedAt);
    footer.textContent = lastCheckedAt ? `数据时间 ${new Date(lastCheckedAt).toLocaleString("zh-CN")}` : "";
  }
  async function queryDeep(force = false) {
    deep.classList.add("loading");
    try {
      const data = await request(`${ROOT}/deepseek${force ? "?refresh=1" : ""}`);
      renderDeepSeek(deep, data);
      hasDeepData = true;
      updateFooter(data);
    } catch (error) {
      if (hasDeepData) showStale(deep, error);
      else showError(deep, error);
    }
    finally { deep.classList.remove("loading"); }
  }
  function paintAccounts() {
    cpa.replaceChildren();
    if (!accounts.length) return cpa.appendChild(el("div", "empty", "CPA 中没有可用的 Codex 认证账号"));
    accounts.forEach((account) => cpa.appendChild(accountCard(account, queryAccount)));
  }
  async function queryCpa(force = false) {
    cpa.classList.add("loading");
    try {
      const data = await request(`${ROOT}/cpa${force ? "?refresh=1" : ""}`);
      accounts = data.accounts || [];
      paintAccounts();
      hasCpaData = true;
      updateFooter(data);
    } catch (error) {
      const needsKey = ["credential_missing", "cpa_auth_blocked"].includes(error?.code) || [401, 403].includes(error?.status);
      if (hasCpaData) showStale(cpa, error);
      else showError(cpa, error);
      clearKeyForms(cpa);
      if (needsKey) {
        cpa.appendChild(keyForm(() => queryCpa(true)));
      }
    }
    finally { cpa.classList.remove("loading"); }
  }
  async function queryAccount(id, button) {
    button.disabled = true;
    const card = cpa.querySelector(`[data-account-id="${CSS.escape(id)}"]`);
    card?.classList.add("loading");
    try {
      const data = await request(`${ROOT}/cpa?account=${encodeURIComponent(id)}&refresh=1`), updated = data.accounts?.[0];
      if (updated) accounts = accounts.map((account) => account.id === id ? updated : account);
      paintAccounts();
      updateFooter(data);
    } catch (error) {
      if (card) {
        card.querySelector(".stale-notice")?.remove();
        card.appendChild(el("div", "stale-notice", `更新失败，保留上次数据：${error.message}`));
      }
    } finally { button.disabled = false; card?.classList.remove("loading"); }
  }
  async function queryAll(force = false) {
    refreshAll.disabled = true;
    try { await Promise.all([queryDeep(force), queryCpa(force)]); }
    finally { loaded = true; refreshAll.disabled = false; }
  }
  function panelIsOpen() { return panel.matches(":popover-open") || panel.classList.contains("open"); }
  function positionPanel() {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(430, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    panel.style.maxHeight = `${Math.max(220, Math.min(500, rect.top - 16))}px`;
  }
  function animatePanel(opening) {
    motion?.cancel();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof panel.animate !== "function") return Promise.resolve();
    const frames = opening
      ? [{ opacity: 0, transform: "translateY(8px) scale(.98)" }, { opacity: 1, transform: "translateY(0) scale(1)" }]
      : [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(8px) scale(.98)" }];
    motion = panel.animate(frames, { duration: opening ? 180 : 145, easing: opening ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    return motion.finished.catch(() => {});
  }
  async function openPanel() {
    desiredOpen = true;
    const token = ++motionToken;
    positionPanel();
    if (typeof panel.showPopover === "function") {
      if (!panel.matches(":popover-open")) panel.showPopover();
    } else panel.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    if (!loaded) queryAll();
    await animatePanel(true);
    if (token === motionToken && desiredOpen) motion?.cancel();
  }
  async function closePanel() {
    desiredOpen = false;
    const token = ++motionToken;
    await animatePanel(false);
    if (token !== motionToken || desiredOpen) return;
    if (typeof panel.hidePopover === "function" && panel.matches(":popover-open")) panel.hidePopover();
    panel.classList.remove("open");
    motion?.cancel();
    panel.style.removeProperty("opacity");
    panel.style.removeProperty("transform");
    trigger.setAttribute("aria-expanded", "false");
  }
  function togglePanel() { desiredOpen ? closePanel() : openPanel(); }
  trigger.addEventListener("click", togglePanel);
  panel.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(panelIsOpen())));
  refreshAll.addEventListener("click", () => queryAll(true));
  refreshDeep.addEventListener("click", async () => { refreshDeep.disabled = true; await queryDeep(true); refreshDeep.disabled = false; });
  refreshCpa.addEventListener("click", async () => { refreshCpa.disabled = true; await queryCpa(true); refreshCpa.disabled = false; });
  window.addEventListener("resize", () => { detectSafeButtonPosition(); if (panelIsOpen()) positionPanel(); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
else mount();
