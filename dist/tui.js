// main.ts
import { createSignal as createSignal2 } from "solid-js";
import { createComponent } from "@opentui/solid";
import fs from "node:fs";

// src/active-provider.ts
function asRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function strField(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" && v !== "" ? v : void 0;
}
function providerIdFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asRecord(messages[i]);
    if (!msg) continue;
    const role = strField(msg, "role");
    if (role === "assistant") {
      const direct = strField(msg, "providerID");
      if (direct) return direct;
      continue;
    }
    if (role === "user") {
      const nested = strField(asRecord(msg.model), "providerID");
      if (nested) return nested;
    }
  }
  return void 0;
}
function providerIdFromConfig(config) {
  const rec = asRecord(config);
  if (!rec) return void 0;
  for (const key of ["model", "small_model"]) {
    const raw = strField(rec, key);
    if (!raw) continue;
    const head = raw.split("/")[0]?.trim();
    if (head) return head;
  }
  return void 0;
}
function resolveActiveProvider(input) {
  const fromMessage = providerIdFromMessages(input.messages);
  if (fromMessage) return { providerID: fromMessage, source: "message" };
  const fromConfig = providerIdFromConfig(input.config);
  if (fromConfig) return { providerID: fromConfig, source: "config" };
  return { providerID: void 0, source: "none" };
}

// src/http.ts
function matchesAny(haystack, needles) {
  const s = haystack.toLowerCase();
  return needles.some((n) => s.includes(n));
}
function hostOf(baseURL) {
  try {
    const u = new URL(baseURL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseURL.toLowerCase().split("/api/")[0] ?? baseURL;
  }
}
function trimSlashes(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end -= 1;
  return s.slice(0, end);
}
function pickProvider(list, match, prefer) {
  const hit = list.filter(match);
  if (!hit.length) return void 0;
  const preferred = prefer ? hit.find(prefer) : void 0;
  return preferred ?? hit[0];
}
var REQUEST_TIMEOUT_MS = 8e3;
async function getJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`\u54CD\u5E94\u4E0D\u662F JSON\uFF1A${text.slice(0, 120)}`);
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${REQUEST_TIMEOUT_MS / 1e3}s\uFF09\uFF0C\u68C0\u67E5\u7F51\u7EDC\u6216\u4EE3\u7406`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// src/parsers/common.ts
function asRecord2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function toNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return void 0;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return void 0;
}
function strField2(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" ? v : void 0;
}
function limitsOf(data) {
  const raw = data.limits;
  if (!Array.isArray(raw)) return [];
  return raw.map(asRecord2);
}
function pctOf(used, limit) {
  if (used == null || limit == null || limit <= 0) return void 0;
  return Math.max(0, Math.min(100, used / limit * 100));
}
function normalizeEpoch(n) {
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1e3;
  return n;
}
function stringToMs(s) {
  const t = s.trim();
  if (t === "") return void 0;
  const n = Number(t);
  if (Number.isFinite(n) && n > 1e9) return normalizeEpoch(n);
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? void 0 : parsed;
}
function timeToMs(v) {
  if (typeof v === "number") return normalizeEpoch(v);
  if (typeof v === "string") return stringToMs(v);
  return void 0;
}
function formatResetLabel(d) {
  const now = /* @__PURE__ */ new Date();
  const pad = (x) => String(x).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatReset(v) {
  const ms = timeToMs(v);
  if (ms == null) return void 0;
  return formatResetLabel(new Date(ms));
}
function windowRank(label) {
  if (label === "5h") return 0;
  if (label === "\u5468") return 1;
  return 2;
}
function sortByDisplayOrder(windows) {
  return windows.sort((a, b) => windowRank(a.label) - windowRank(b.label));
}

// src/parsers/deepseek.ts
function currencyPrefix(currency) {
  if (currency === "CNY") return "\xA5";
  const c = typeof currency === "string" ? currency : "";
  return c === "" ? "" : `${c} `;
}
function balanceText(currency, balance) {
  if (typeof balance === "number") return `${currencyPrefix(currency)}${String(balance)}`;
  if (typeof balance === "string") return `${currencyPrefix(currency)}${balance}`;
  throw new Error("balance_infos.total_balance \u7C7B\u578B\u5F02\u5E38\uFF08\u975E string/number\uFF09");
}
function parseDeepSeekBalance(json) {
  const root = asRecord2(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  if (root.is_available === false) throw new Error("\u8D26\u53F7\u4E0D\u53EF\u7528");
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos.map(asRecord2).filter((r) => r != null) : [];
  const cny = infos.find((i) => i?.currency === "CNY") ?? infos[0];
  if (!cny) throw new Error("\u54CD\u5E94\u4E2D\u65E0 balance_infos");
  return { windows: [], extras: [{ label: "\u4F59\u989D", value: balanceText(cny.currency, cny.total_balance) }] };
}

// src/providers/deepseek.ts
var isDeepSeek = (p) => matchesAny(p.baseURL ?? "", ["api.deepseek.com"]) || p.id === "deepseek";
async function fetchDeepSeek(p) {
  if (!p.apiKey) throw new Error("DeepSeek provider \u7F3A\u5C11 apiKey");
  const origin = p.baseURL ? hostOf(p.baseURL) : "https://api.deepseek.com";
  const json = await getJson(`${origin}/user/balance`, { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" });
  return parseDeepSeekBalance(json);
}
var deepseekAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  match: isDeepSeek,
  fetch: fetchDeepSeek
};

// src/parsers/glm.ts
function glmWindowRow(l, label) {
  const total = toNum(l?.usage);
  const used = toNum(l?.currentValue);
  return {
    label,
    usedPct: toNum(l?.percentage) ?? pctOf(used, total),
    used,
    limit: total,
    resetLabel: formatReset(l?.nextResetTime)
  };
}
function glmLegacyLabel(count, index) {
  if (count <= 1) return "\u989D\u5EA6";
  if (index === 0) return "5h";
  return "\u5468";
}
function glmCreditLabel(l, fallback) {
  const unit = toNum(l?.unit);
  const number = toNum(l?.number);
  if (unit === 3 && number === 5) return "5h";
  if (unit != null && number != null) return "\u5468";
  return fallback;
}
function glmWindows(data) {
  const rawLimits = limitsOf(data);
  const windows = [];
  const tokenLike = rawLimits.filter((l) => l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT");
  const sorted = [...tokenLike].sort(
    (a, b) => (toNum(a?.nextResetTime) ?? Number.MAX_SAFE_INTEGER) - (toNum(b?.nextResetTime) ?? Number.MAX_SAFE_INTEGER)
  );
  sorted.forEach((l, i) => {
    windows.push(glmWindowRow(l, glmCreditLabel(l, glmLegacyLabel(sorted.length, i))));
  });
  const mcp = rawLimits.find((l) => l?.type === "TIME_LIMIT");
  if (mcp) windows.push(glmWindowRow(mcp, "MCP"));
  return sortByDisplayOrder(windows);
}
function parseGlmQuota(json) {
  const root = asRecord2(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  if (root.success === false) throw new Error(strField2(root, "msg") ?? "\u63A5\u53E3\u8FD4\u56DE\u5931\u8D25");
  const data = asRecord2(root.data) ?? root;
  const windows = glmWindows(data);
  if (!windows.length) throw new Error("\u54CD\u5E94\u4E2D\u65E0 TOKENS_LIMIT/CREDIT_LIMIT \u7A97\u53E3");
  return { level: strField2(data, "level"), windows, extras: [] };
}

// src/providers/glm.ts
var isGlm = (p) => matchesAny(p.baseURL ?? "", ["open.bigmodel.cn", "api.z.ai"]) || matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["zhipu", "bigmodel", "z.ai"]);
var isGlmCoding = (p) => (p.baseURL ?? "").includes("/coding/");
async function fetchGlm(p) {
  if (!p.apiKey || !p.baseURL) throw new Error("GLM provider \u7F3A\u5C11 apiKey/baseURL");
  const json = await getJson(`${hostOf(p.baseURL)}/api/monitor/usage/quota/limit`, {
    Authorization: p.apiKey,
    // 实测：智谱监控接口为裸 key，不带 Bearer 前缀
    "Content-Type": "application/json",
    "Accept-Language": "en-US,en"
  });
  return parseGlmQuota(json);
}
var glmAdapter = {
  id: "glm",
  label: "GLM",
  match: isGlm,
  prefer: isGlmCoding,
  fetch: fetchGlm
};

// src/parsers/kimi.ts
function kimiWindowLabel(win) {
  const dur = toNum(win?.duration);
  const unit = strField2(win, "timeUnit") ?? "";
  if (unit.includes("MINUTE") && dur === 300) return "5h";
  if (dur == null) return "\u7A97\u53E3";
  if (unit.includes("MINUTE")) return `${dur}m`;
  if (unit.includes("HOUR")) return `${dur}h`;
  if (unit.includes("DAY")) return `${dur}d`;
  return `${dur}`;
}
function kimiUsed(detail, limit) {
  const used = toNum(detail?.used);
  if (used != null) return used;
  const remaining = toNum(detail?.remaining);
  if (remaining != null && limit != null) return limit - remaining;
  return void 0;
}
function kimiWindows(root) {
  const windows = [];
  const usage = asRecord2(root.usage);
  if (usage) {
    const limit = toNum(usage.limit);
    const used = kimiUsed(usage, limit);
    windows.push({
      label: "\u5468",
      usedPct: pctOf(used, limit),
      used,
      limit,
      resetLabel: formatReset(usage.resetTime ?? usage.reset_at)
    });
  }
  for (const item of limitsOf(root)) {
    const detail = asRecord2(item?.detail) ?? item;
    const limit = toNum(detail?.limit);
    const used = kimiUsed(detail, limit);
    windows.push({
      label: kimiWindowLabel(asRecord2(item?.window)),
      usedPct: pctOf(used, limit),
      used,
      limit,
      resetLabel: formatReset(detail?.resetTime ?? detail?.reset_at)
    });
  }
  return windows;
}
function kimiExtras(root) {
  const cents = toNum(asRecord2(asRecord2(root.boosterWallet)?.monthlyUsed)?.priceInCents);
  if (cents == null) return [];
  return [{ label: "\u6708\u6D88", value: `\xA5${(cents / 100).toFixed(2)}` }];
}
function stripLevelPrefix(level) {
  if (level == null) return void 0;
  return level.startsWith("LEVEL_") ? level.slice("LEVEL_".length) : level;
}
function parseKimiQuota(json) {
  const root = asRecord2(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  const windows = kimiWindows(root);
  if (!windows.length) throw new Error("\u54CD\u5E94\u4E2D\u65E0 usage/limits \u7A97\u53E3");
  sortByDisplayOrder(windows);
  const level = strField2(asRecord2(asRecord2(root.user)?.membership), "level");
  return { level: stripLevelPrefix(level), windows, extras: kimiExtras(root) };
}

// src/providers/kimi.ts
var isKimi = (p) => matchesAny(p.baseURL ?? "", ["api.kimi.com/coding"]) || p.id === "kimi";
async function fetchKimi(p) {
  if (!p.apiKey || !p.baseURL) throw new Error("Kimi provider \u7F3A\u5C11 apiKey/baseURL");
  const base = trimSlashes(p.baseURL);
  const json = await getJson(`${base}/usages`, { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" });
  return parseKimiQuota(json);
}
var kimiAdapter = {
  id: "kimi",
  label: "Kimi",
  match: isKimi,
  fetch: fetchKimi
};

// src/parsers/minimax.ts
function pickEntry(entries) {
  const byName = (pred) => entries.find((e) => pred(strField2(e, "model_name") ?? ""));
  return byName((n) => /^minimax-m/i.test(n)) ?? byName((n) => n === "general") ?? byName((n) => n === "chat" || n === "text");
}
function minmaxWindow(entry, prefix, label) {
  if (toNum(entry[`current_${prefix}_status`]) === 3) {
    return { label, unlimited: true };
  }
  const remaining = toNum(entry[`current_${prefix}_remaining_percent`]);
  const usedPct = remaining == null ? void 0 : Math.max(0, Math.min(100, 100 - remaining));
  return {
    label,
    usedPct,
    // 陷阱 3：老套餐 total 恒为 0，used/limit 一律留空，交由 UI 渲染纯百分比行
    resetLabel: formatReset(prefix === "interval" ? entry.end_time : entry.weekly_end_time)
  };
}
function minmaxLevel(entry) {
  const name = strField2(entry, "model_name");
  if (name == null || !/^minimax-m/i.test(name)) return void 0;
  return name;
}
function parseMinimaxQuota(json) {
  const root = asRecord2(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  const baseResp = asRecord2(root.base_resp);
  const code = toNum(baseResp?.status_code);
  if (code != null && code !== 0) {
    throw new Error(strField2(baseResp, "status_msg") ?? `\u63A5\u53E3\u8FD4\u56DE\u5931\u8D25\uFF08status_code=${code}\uFF09`);
  }
  const raw = root.model_remains;
  const entries = Array.isArray(raw) ? raw.map(asRecord2).filter((e) => e != null) : [];
  const entry = pickEntry(entries);
  if (!entry) throw new Error("\u54CD\u5E94\u4E2D\u65E0\u53EF\u7528\u989D\u5EA6\u6761\u76EE\uFF08model_remains \u4E3A\u7A7A\u6216 model_name \u4E0D\u53EF\u8BC6\u522B\uFF09");
  const windows = [minmaxWindow(entry, "interval", "5h"), minmaxWindow(entry, "weekly", "\u5468")];
  return { level: minmaxLevel(entry), windows: sortByDisplayOrder(windows), extras: [] };
}

// src/providers/minimax.ts
var MINIMAX_HOSTS = ["api.minimaxi.com", "www.minimaxi.com", "api.minimax.io", "api.minimax.cn"];
var isMinimax = (p) => matchesAny(p.baseURL ?? "", MINIMAX_HOSTS) || // 用户真实 provider id 形如 minimax-cn-coding-plan，只看 id/name 也要能命中
matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["minimax"]);
var MINIMAX_DEFAULT_ORIGIN = "https://api.minimaxi.com";
async function fetchMinimax(p) {
  if (!p.apiKey) throw new Error("MiniMax provider \u7F3A\u5C11 apiKey");
  const origin = p.baseURL ? hostOf(p.baseURL) : MINIMAX_DEFAULT_ORIGIN;
  const json = await getJson(`${origin}/v1/token_plan/remains`, {
    Authorization: `Bearer ${p.apiKey}`,
    Accept: "application/json"
  });
  return parseMinimaxQuota(json);
}
var minimaxAdapter = {
  id: "minimax",
  label: "MiniMax",
  match: isMinimax,
  fetch: fetchMinimax
};

// src/providers/index.ts
var PROVIDERS = [glmAdapter, minimaxAdapter, kimiAdapter, deepseekAdapter];
var DEFAULT_ORIGIN_OK = /* @__PURE__ */ new Set(["minimax", "deepseek"]);
function nonEmpty(s) {
  return s != null && s.trim() !== "";
}
function adapterForProviderId(providerId) {
  return PROVIDERS.find((a) => a.match({ id: providerId }));
}
function fetchQuota(adapter, providers) {
  const p = pickProvider(providers, adapter.match, adapter.prefer);
  if (!p) throw new Error(`\u672A\u627E\u5230 ${adapter.label} \u7684 provider \u914D\u7F6E\uFF08host provider \u5217\u8868\u91CC\u6CA1\u6709\u53EF\u5339\u914D\u6761\u76EE\uFF09`);
  return adapter.fetch(p);
}
function usableEntry(adapter, p) {
  if (!p || !nonEmpty(p.apiKey)) return false;
  if (nonEmpty(p.baseURL)) return true;
  return DEFAULT_ORIGIN_OK.has(adapter.id);
}
function availableAdapters(providers) {
  return PROVIDERS.filter((a) => usableEntry(a, pickProvider(providers, a.match, a.prefer)));
}

// src/ui/panel.tsx
import { use as _$use } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

// src/ui/format.ts
function formatNumber(n) {
  if (!Number.isFinite(n)) return "\u2014";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString("en-US");
}
function formatPercentage(n) {
  const rounded = Math.floor(n * 10) / 10;
  if (Number.isInteger(rounded)) return rounded + "%";
  return rounded.toFixed(1) + "%";
}
var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function formatResetCountdown(resetTime, now = Date.now()) {
  if (resetTime === null) return "\u2014";
  const diffMs = resetTime - now;
  if (diffMs <= 0) return "\u2014";
  const totalMinutes = Math.floor(diffMs / (1e3 * 60));
  if (totalMinutes >= 24 * 60) {
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours2 = totalHours % 24;
    return `${days}d ${hours2}h`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
function formatResetClock(resetTime, now = Date.now()) {
  if (resetTime === null) return "";
  const diffMs = resetTime - now;
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / (1e3 * 60));
  const resetDate = new Date(resetTime);
  const hh = String(resetDate.getHours()).padStart(2, "0");
  const mm = String(resetDate.getMinutes()).padStart(2, "0");
  if (totalMinutes >= 24 * 60) {
    return `${DAY_NAMES[resetDate.getDay()]} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}
function formatClockShort(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
var TIME_RE = /^(\d{1,2}):(\d{2})$/;
var DATE_RE = /^(\d{1,2})-(\d{1,2})$/;
var DATE_TIME_RE = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/;
function resolveResetAt(resetLabel, now) {
  if (!resetLabel) return null;
  const label = resetLabel.trim();
  const dateTime = DATE_TIME_RE.exec(label);
  if (dateTime) {
    const at = buildLocal(now, +dateTime[1], +dateTime[2], +dateTime[3], +dateTime[4]);
    if (at !== null && at > now) return { at, hasClock: true };
  }
  const time = TIME_RE.exec(label);
  if (time) {
    const at = buildLocal(now, nowMonth(now), nowDay(now), +time[1], +time[2]);
    if (at !== null && at <= now) {
      const next = new Date(at);
      next.setDate(next.getDate() + 1);
      return { at: next.getTime(), hasClock: true };
    }
    if (at !== null) return { at, hasClock: true };
  }
  const date = DATE_RE.exec(label);
  if (date) {
    let at = buildLocal(now, +date[1], +date[2], 0, 0);
    if (at === null) return null;
    if (at <= now) at = new Date(new Date(at).setFullYear(new Date(at).getFullYear() + 1)).getTime();
    return { at, hasClock: false };
  }
  return null;
}
function nowMonth(now) {
  return new Date(now).getMonth() + 1;
}
function nowDay(now) {
  return new Date(now).getDate();
}
function buildLocal(now, month, day, hour, minute) {
  if (month < 1 || month > 12) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  const base = new Date(now);
  const d = new Date(base.getFullYear(), month - 1, day, hour, minute, 0, 0);
  if (d.getMonth() !== month - 1) return null;
  if (d.getDate() !== day) return null;
  return d.getTime();
}

// src/ui/theme.ts
function rgb(raw) {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw;
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255;
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale)
      };
    }
  }
  return null;
}
function saturation(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const L = (max + min) / 2;
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
}
function desaturateTo(raw, maxSat, fallback) {
  const c = rgb(raw);
  if (!c) return fallback;
  const sat = saturation(c.r, c.g, c.b);
  if (sat <= maxSat) {
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const nr2 = Math.round(c.r + (luma - c.r) * mid);
    const ng2 = Math.round(c.g + (luma - c.g) * mid);
    const nb2 = Math.round(c.b + (luma - c.b) * mid);
    if (saturation(nr2, ng2, nb2) > maxSat) lo = mid;
    else hi = mid;
  }
  const nr = Math.round(c.r + (luma - c.r) * hi);
  const ng = Math.round(c.g + (luma - c.g) * hi);
  const nb = Math.round(c.b + (luma - c.b) * hi);
  return "#" + [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}
function dimColor(hex, factor = 0.5) {
  const c = rgb(hex);
  if (!c) return hex;
  const r = Math.round(c.r * factor);
  const g = Math.round(c.g * factor);
  const b = Math.round(c.b * factor);
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}
var FALLBACK = {
  primary: "#8B9DAF",
  text: "#C5C5BB",
  muted: "#7A7A72",
  accent: "#C9A0DC",
  info: "#8DA9B8",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error: "#B08A8A",
  border: "#6B6B63"
};
var MAX_SAT = 0.28;
var SOURCES = {
  primary: "primary",
  text: "text",
  muted: "textMuted",
  accent: "accent",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
  border: "border"
};
function buildPalette(theme) {
  const pick = (slot) => desaturateTo(theme?.[SOURCES[slot]], MAX_SAT, null);
  const primary = pick("primary");
  const text = pick("text");
  const muted = pick("muted");
  const success = pick("success");
  const warning = pick("warning");
  const error = pick("error");
  const border = pick("border") ?? desaturateTo(theme?.borderSubtle, MAX_SAT, null) ?? muted;
  const secondary = desaturateTo(theme?.secondary, MAX_SAT, null);
  const accent = pick("accent") ?? primary ?? text;
  const info = pick("info") ?? secondary ?? muted ?? text;
  return {
    primary: primary ?? FALLBACK.primary,
    text: text ?? FALLBACK.text,
    muted: muted ?? FALLBACK.muted,
    accent: accent ?? FALLBACK.accent,
    info: info ?? FALLBACK.info,
    success: success ?? FALLBACK.success,
    warning: warning ?? FALLBACK.warning,
    error: error ?? FALLBACK.error,
    border: border ?? FALLBACK.border
  };
}
function quotaColor(percentage, pal) {
  if (percentage >= 90) return pal.error;
  if (percentage >= 70) return pal.warning;
  return pal.success;
}

// src/ui/widgets.ts
function charColumns(c) {
  const code = c.codePointAt(0) ?? 0;
  if (code < 32) return 0;
  if (code < 127) return 1;
  if (code < 160) return 0;
  if (code >= 4352 && code <= 4447 || // Hangul Jamo
  code >= 11904 && code <= 42191 || // CJK Radicals … Yi
  code >= 44032 && code <= 55203 || // Hangul
  code >= 63744 && code <= 64255 || // CJK Compat
  code >= 65040 && code <= 65135 || // Vertical / Compat
  code >= 65281 && code <= 65376 || // Fullwidth
  code >= 65504 && code <= 65510 || // Fullwidth signs
  code >= 127744 && code <= 128591 || // Misc Symbols (emoji)
  code >= 131072 && code <= 262141)
    return 2;
  return 1;
}
function visualWidth(s) {
  let w = 0;
  for (const c of s) w += charColumns(c);
  return w;
}
function truncateVisual(s, maxCols) {
  if (visualWidth(s) <= maxCols) return s;
  let result = "";
  let w = 0;
  for (const c of s) {
    const cw = charColumns(c);
    if (w + cw > maxCols - 1) {
      result += "\u2026";
      break;
    }
    result += c;
    w += cw;
  }
  return result;
}
function progressBar(percent, width) {
  const clamped = Math.max(0, Math.min(100, percent));
  const exactFilled = clamped / 100 * width;
  const filled = Math.floor(exactFilled);
  if (filled >= width) {
    return "\u2588".repeat(width);
  }
  const fraction = exactFilled - filled;
  let transition = "";
  let empty = Math.max(0, width - filled);
  if (fraction >= 2 / 3) {
    transition = "\u2593";
    empty -= 1;
  } else if (fraction >= 1 / 3) {
    transition = "\u2592";
    empty -= 1;
  }
  return "\u2588".repeat(filled) + transition + "\u2591".repeat(empty);
}
var MIN_PANEL_WIDTH = 20;
var DEFAULT_PANEL_WIDTH = 30;
var BAR_BRACKETS = 2;
var BAR_GAP = 1;
var PCT_WIDTH = 4;
var HEADER_PREFIX = 2;
var UNLIMITED_GLYPH = "\u221E";

// src/ui/panel.tsx
var KV_NAMESPACE = "quota_switch";
var FOLD_OPEN = "\u25BC ";
var FOLD_SHUT = "\u25B6 ";
var SEP = "\u2500";
function QuotaPanel(props) {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH);
  const [open, setOpen] = createSignal(true);
  const [borderVisible, setBorderVisible] = createSignal(true);
  const [now, setNow] = createSignal(Date.now());
  let boxEl;
  let tickTimer;
  let kvPollTimer;
  const themeReady = () => props.theme.ready && !!props.theme.current;
  const pal = createMemo(() => {
    void props.theme.selected;
    return buildPalette(themeReady() ? props.theme.current : void 0);
  });
  const persist = (key, value) => {
    try {
      props.kv.set(`${KV_NAMESPACE}.${key}`, value);
    } catch {
    }
  };
  const applyStoredConfig = () => {
    try {
      setOpen(props.kv.get(`${KV_NAMESPACE}.open`, true) !== false);
      setBorderVisible(props.kv.get(`${KV_NAMESPACE}.border`, true) !== false);
    } catch {
    }
  };
  const restoreConfig = () => {
    try {
      if (props.kv.ready) {
        applyStoredConfig();
        return;
      }
      let tries = 0;
      const poll = () => {
        if (props.kv.ready || ++tries > 100) {
          applyStoredConfig();
          return;
        }
        kvPollTimer = setTimeout(poll, 10);
      };
      poll();
    } catch {
    }
  };
  onMount(() => {
    tickTimer = setInterval(() => setNow(Date.now()), 1e3);
    restoreConfig();
  });
  onCleanup(() => {
    if (tickTimer !== void 0) clearInterval(tickTimer);
    if (kvPollTimer !== void 0) clearTimeout(kvPollTimer);
  });
  let seenRefreshSignal = props.refreshSignal();
  createEffect(() => {
    const tick = props.refreshSignal();
    if (tick === seenRefreshSignal) return;
    seenRefreshSignal = tick;
    props.onRefresh?.();
  });
  const gutter = createMemo(() => borderVisible() ? 6 : 0);
  const gauge = createMemo(() => panelWidth() - gutter());
  const sep = createMemo(() => SEP.repeat(Math.max(1, gauge())));
  const measure = () => {
    const raw = boxEl && typeof boxEl.width === "number" && boxEl.width > 0 ? boxEl.width : DEFAULT_PANEL_WIDTH;
    const w = Math.max(MIN_PANEL_WIDTH, raw);
    setPanelWidth((prev) => prev === w ? prev : w);
  };
  createEffect(() => {
    borderVisible();
    measure();
  });
  const borderProps = () => borderVisible() ? {
    border: true,
    borderColor: pal().border
  } : {
    border: false
  };
  const snap = () => props.snapshot();
  const quota = () => snap()?.quota;
  const headPct = () => {
    for (const w of quota()?.windows ?? []) {
      if (w.usedPct !== void 0) return w.usedPct;
    }
    return void 0;
  };
  const spaces = (n) => n >= 1 ? " ".repeat(n) : "";
  const padTo = (head, tail, width) => spaces(width - visualWidth(head) - visualWidth(tail));
  const LabeledValue = (p) => {
    const pad = createMemo(() => padTo(p.label, p.value, gauge()));
    const tight = createMemo(() => " " + truncateVisual(p.value, Math.max(1, gauge() - visualWidth(p.label) - 1)));
    return (() => {
      var _el$ = _$createElement("text"), _el$2 = _$createElement("span");
      _$insertNode(_el$, _el$2);
      _$insert(_el$2, () => p.label);
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return pad();
        },
        get children() {
          var _el$3 = _$createElement("span");
          _$insert(_el$3, () => pad() + p.value);
          _$effect((_$p) => _$setProp(_el$3, "style", {
            fg: pal().accent
          }, _$p));
          return _el$3;
        }
      }), null);
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return !pad();
        },
        get children() {
          var _el$4 = _$createElement("span");
          _$insert(_el$4, tight);
          _$effect((_$p) => _$setProp(_el$4, "style", {
            fg: pal().accent
          }, _$p));
          return _el$4;
        }
      }), null);
      _$effect((_$p) => _$setProp(_el$2, "style", {
        fg: pal().info
      }, _$p));
      return _el$;
    })();
  };
  const QuotaBlock = (p) => {
    const win = () => p.win;
    const isUnlimited = () => win().unlimited === true;
    const hasPct = () => win().usedPct !== void 0;
    const pct = () => win().usedPct ?? 0;
    const usedTotal = () => {
      const u = win().used;
      const l = win().limit;
      return u !== void 0 && l !== void 0 ? `${formatNumber(u)}/${formatNumber(l)}` : "";
    };
    const label = () => truncateVisual(win().label, Math.max(1, gauge()));
    const labelPad = () => padTo(label(), usedTotal(), gauge());
    const labelTight = () => " " + truncateVisual(usedTotal(), Math.max(1, gauge() - visualWidth(label()) - 1));
    const pctText = () => formatPercentage(pct());
    const pctPad = () => " ".repeat(Math.max(BAR_GAP, PCT_WIDTH - visualWidth(pctText())));
    const barWidth = () => Math.max(1, gauge() - BAR_BRACKETS - visualWidth(pctPad()) - visualWidth(pctText()));
    const barFits = () => gauge() - BAR_BRACKETS - visualWidth(pctPad()) - visualWidth(pctText()) >= 1;
    const reset = () => resolveResetAt(win().resetLabel, now());
    const resetClock = () => {
      const r = reset();
      if (!r) return "";
      return r.hasClock ? formatResetClock(r.at, now()) : truncateVisual(win().resetLabel ?? "", 8);
    };
    const resetHead = () => truncateVisual("\u91CD\u7F6E: " + formatResetCountdown(reset().at, now()), gauge());
    const resetTailPad = () => padTo(resetHead(), resetClock(), gauge());
    return [
      (() => {
        var _el$5 = _$createElement("text"), _el$6 = _$createElement("span");
        _$insertNode(_el$5, _el$6);
        _$insert(_el$6, label);
        _$insert(_el$5, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!usedTotal())() && labelPad();
          },
          get children() {
            var _el$7 = _$createElement("span");
            _$insert(_el$7, () => labelPad() + usedTotal());
            _$effect((_$p) => _$setProp(_el$7, "style", {
              fg: pal().accent
            }, _$p));
            return _el$7;
          }
        }), null);
        _$insert(_el$5, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!usedTotal())() && !labelPad();
          },
          get children() {
            var _el$8 = _$createElement("span");
            _$insert(_el$8, labelTight);
            _$effect((_$p) => _$setProp(_el$8, "style", {
              fg: pal().accent
            }, _$p));
            return _el$8;
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$6, "style", {
          fg: pal().info
        }, _$p));
        return _el$5;
      })(),
      // 无限量窗口：只画一个 ∞，不画条、不画百分比（hasPct 为 false 时下面的条形行自动跳过）
      _$createComponent(Show, {
        get when() {
          return isUnlimited();
        },
        get children() {
          var _el$9 = _$createElement("text"), _el$0 = _$createElement("span");
          _$insertNode(_el$9, _el$0);
          _$insert(_el$0, " " + UNLIMITED_GLYPH);
          _$effect((_$p) => _$setProp(_el$0, "style", {
            fg: pal().info
          }, _$p));
          return _el$9;
        }
      }),
      // 已知 bug 修复 #3：没有百分比语义就整行不画 —— 既不画一条假的 0% 空条，
      // 也不把整个窗口藏起来。标签行右边的 used/limit 照常显示。
      _$createComponent(Show, {
        get when() {
          return hasPct();
        },
        get children() {
          return _$createComponent(Show, {
            get when() {
              return barFits();
            },
            get fallback() {
              return (() => {
                var _el$14 = _$createElement("text"), _el$15 = _$createElement("span");
                _$insertNode(_el$14, _el$15);
                _$insert(_el$15, () => pctPad() + pctText());
                _$effect((_$p) => _$setProp(_el$15, "style", {
                  fg: quotaColor(pct(), pal())
                }, _$p));
                return _el$14;
              })();
            },
            get children() {
              var _el$1 = _$createElement("text"), _el$10 = _$createElement("span"), _el$11 = _$createTextNode(`[`), _el$12 = _$createTextNode(`]`), _el$13 = _$createElement("span");
              _$insertNode(_el$1, _el$10);
              _$insertNode(_el$1, _el$13);
              _$insertNode(_el$10, _el$11);
              _$insertNode(_el$10, _el$12);
              _$insert(_el$10, () => progressBar(pct(), barWidth()), _el$12);
              _$insert(_el$13, () => pctPad() + pctText());
              _$effect((_p$) => {
                var _v$ = {
                  fg: quotaColor(pct(), pal())
                }, _v$2 = {
                  fg: pal().accent
                };
                _v$ !== _p$.e && (_p$.e = _$setProp(_el$10, "style", _v$, _p$.e));
                _v$2 !== _p$.t && (_p$.t = _$setProp(_el$13, "style", _v$2, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$1;
            }
          });
        }
      }),
      _$createComponent(Show, {
        get when() {
          return reset();
        },
        get children() {
          var _el$16 = _$createElement("text"), _el$17 = _$createElement("span");
          _$insertNode(_el$16, _el$17);
          _$insert(_el$17, resetHead);
          _$insert(_el$16, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!resetClock())() && resetTailPad();
            },
            get children() {
              var _el$18 = _$createElement("span");
              _$insert(_el$18, () => " (" + resetClock() + ")");
              _$effect((_$p) => _$setProp(_el$18, "style", {
                fg: dimColor(pal().muted, 0.75)
              }, _$p));
              return _el$18;
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$17, "style", {
            fg: pal().muted
          }, _$p));
          return _el$16;
        }
      })
    ];
  };
  const Notice = (p) => (() => {
    var _el$19 = _$createElement("text"), _el$20 = _$createElement("span"), _el$21 = _$createElement("span");
    _$insertNode(_el$19, _el$20);
    _$insertNode(_el$19, _el$21);
    _$insert(_el$20, () => p.icon + " ");
    _$insert(_el$21, () => truncateVisual(p.text, Math.max(1, gauge() - 2)));
    _$effect((_p$) => {
      var _v$3 = {
        fg: p.fg
      }, _v$4 = {
        fg: p.fg
      };
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$20, "style", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$21, "style", _v$4, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$19;
  })();
  const headMeta = () => {
    const tag = props.version ? ` v${props.version}` : "";
    const room = gauge() - HEADER_PREFIX - 6;
    return visualWidth(props.title()) + visualWidth(tag) <= room ? tag : "";
  };
  const headTitle = () => truncateVisual(props.title(), Math.max(1, gauge() - HEADER_PREFIX - visualWidth(headMeta())));
  const headClock = () => {
    const s = snap();
    return s ? formatClockShort(new Date(s.fetchedAt)) : "";
  };
  const headPrefixW = () => HEADER_PREFIX + visualWidth(headTitle()) + visualWidth(headMeta());
  const foldedPct = () => {
    const v = headPct();
    return v === void 0 ? "" : formatPercentage(v);
  };
  const headPad = () => spaces(gauge() - headPrefixW() - visualWidth(headClock()));
  const foldedPad = () => spaces(gauge() - headPrefixW() - visualWidth(foldedPct()));
  const body = () => {
    const s = snap();
    if (!s) return _$createComponent(Notice, {
      icon: ">",
      text: "\u52A0\u8F7D\u4E2D\u2026",
      get fg() {
        return pal().muted;
      }
    });
    if (!s.ok) return _$createComponent(Notice, {
      icon: "\u26A0",
      get text() {
        return s.error ?? "\u67E5\u8BE2\u5931\u8D25";
      },
      get fg() {
        return pal().error;
      }
    });
    const q = s.quota;
    if (!q) return _$createComponent(Notice, {
      icon: ">",
      text: "\u6682\u65E0\u6570\u636E",
      get fg() {
        return pal().muted;
      }
    });
    const rows = [];
    if (s.provider) rows.push(_$createComponent(LabeledValue, {
      label: "\u5E73\u53F0:",
      get value() {
        return s.provider;
      }
    }));
    if (q.level) rows.push(_$createComponent(LabeledValue, {
      label: "\u5957\u9910:",
      get value() {
        return q.level;
      }
    }));
    for (const w of q.windows) rows.push(_$createComponent(QuotaBlock, {
      win: w
    }));
    for (const e of q.extras) rows.push(_$createComponent(LabeledValue, {
      get label() {
        return e.label;
      },
      get value() {
        return e.value;
      }
    }));
    if (rows.length === 0) rows.push(_$createComponent(Notice, {
      icon: ">",
      text: "\u6682\u65E0\u6570\u636E",
      get fg() {
        return pal().muted;
      }
    }));
    return rows;
  };
  return (() => {
    var _el$22 = _$createElement("box"), _el$23 = _$createElement("text"), _el$24 = _$createElement("span"), _el$25 = _$createElement("span");
    _$insertNode(_el$22, _el$23);
    var _ref$ = boxEl;
    typeof _ref$ === "function" ? _$use(_ref$, _el$22) : boxEl = _el$22;
    _$spread(_el$22, _$mergeProps(borderProps, {
      "paddingTop": 0,
      "paddingBottom": 0,
      get paddingLeft() {
        return borderVisible() ? 2 : 0;
      },
      get paddingRight() {
        return borderVisible() ? 2 : 0;
      },
      "flexDirection": "column",
      "gap": 0,
      "onSizeChange": measure
    }), true);
    _$insertNode(_el$23, _el$24);
    _$insertNode(_el$23, _el$25);
    _$setProp(_el$23, "onMouseUp", toggle);
    _$insert(_el$24, () => open() ? FOLD_OPEN : FOLD_SHUT);
    _$insert(_el$25, headTitle);
    _$insert(_el$23, _$createComponent(Show, {
      get when() {
        return headMeta();
      },
      get children() {
        var _el$26 = _$createElement("span");
        _$insert(_el$26, headMeta);
        _$effect((_$p) => _$setProp(_el$26, "style", {
          fg: dimColor(pal().muted, 0.6)
        }, _$p));
        return _el$26;
      }
    }), null);
    _$insert(_el$23, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!(open() && headClock()))() && headPad();
      },
      get children() {
        var _el$27 = _$createElement("span");
        _$insert(_el$27, () => headPad() + headClock());
        _$effect((_$p) => _$setProp(_el$27, "style", {
          fg: dimColor(pal().muted, 0.7)
        }, _$p));
        return _el$27;
      }
    }), null);
    _$insert(_el$23, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!(!open() && foldedPct()))() && foldedPad();
      },
      get children() {
        var _el$28 = _$createElement("span");
        _$insert(_el$28, () => foldedPad() + foldedPct());
        _$effect((_$p) => _$setProp(_el$28, "style", {
          fg: quotaColor(headPct() ?? 0, pal())
        }, _$p));
        return _el$28;
      }
    }), null);
    _$insert(_el$22, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        return [(() => {
          var _el$29 = _$createElement("text");
          _$insert(_el$29, sep);
          _$effect((_$p) => _$setProp(_el$29, "fg", pal().muted, _$p));
          return _el$29;
        })(), _$memo(() => body())];
      }
    }), null);
    _$effect((_p$) => {
      var _v$5 = {
        fg: pal().muted
      }, _v$6 = {
        fg: pal().primary
      };
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$24, "style", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$25, "style", _v$6, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$22;
  })();
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      persist("open", next);
      return next;
    });
  }
}

// main.ts
var PLUGIN_VERSION = "0.1.0";
var TRACE_FILE = "/tmp/opencode-quota-switch.log";
function trace(msg) {
  try {
    fs.appendFileSync(TRACE_FILE, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
  }
}
trace("=== \u6A21\u5757\u52A0\u8F7D ===");
function readOptions(raw) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  const str = (v) => typeof v === "string" ? v : void 0;
  const list = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
  return { providers: list(raw?.providers), intervalMs: num(raw?.intervalMs), title: str(raw?.title) };
}
function asRecord3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function hostProviders(api) {
  return api.state.provider.map((p) => {
    const rec = asRecord3(p);
    const options = asRecord3(rec?.options);
    const id = rec?.id;
    const name = rec?.name;
    const baseURL = options?.baseURL;
    const apiKey = options?.apiKey;
    return {
      id: typeof id === "string" ? id : void 0,
      name: typeof name === "string" ? name : void 0,
      baseURL: typeof baseURL === "string" ? baseURL : void 0,
      apiKey: typeof apiKey === "string" ? apiKey : void 0
    };
  });
}
function registerSidebarSlot(api, render) {
  try {
    const modern = api.ui?.slot;
    if (typeof modern === "function") {
      trace("\u6CE8\u518C\uFF1A\u8D70\u65B0\u4EE3 api.ui.slot\uFF0C\u69FD\u540D sidebar.content");
      const off = modern.call(api.ui, { prepend: "sidebar.content", render });
      return { ok: true, dispose: typeof off === "function" ? off : void 0 };
    }
    trace(`\u6CE8\u518C\uFF1A\u65B0\u4EE3 api.ui.slot \u4E0D\u5B58\u5728\uFF08api.ui=${api.ui === void 0 ? "undefined" : typeof api.ui}\uFF09`);
    const register = api.slots?.register;
    if (typeof register !== "function") {
      trace("\u6CE8\u518C\u5931\u8D25\uFF1Aapi.ui.slot \u4E0E api.slots.register \u90FD\u4E0D\u5B58\u5728");
      return { ok: false };
    }
    trace("\u6CE8\u518C\uFF1A\u8D70\u65E7\u4EE3 api.slots.register\uFF0C\u69FD\u540D sidebar_content");
    register.call(api.slots, {
      order: 40,
      slots: { sidebar_content: render }
    });
    return { ok: true };
  } catch (e) {
    trace(`\u6CE8\u518C\u629B\u5F02\u5E38: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return { ok: false };
  }
}
function registerRefreshCommand(api, refresh) {
  const layer = api.keymap.layer;
  if (typeof layer === "function") {
    const off = layer.call(api.keymap, () => ({
      mode: "global",
      commands: [
        {
          id: "quota-switch.refresh",
          title: "Quota: \u7ACB\u5373\u5237\u65B0",
          description: "\u7ACB\u5373\u91CD\u65B0\u62C9\u53D6\u5F53\u524D provider \u7684\u5957\u9910\u7528\u91CF",
          group: "Quota",
          palette: true,
          slash: { name: "quota-refresh" },
          run: refresh
        }
      ]
    }));
    return typeof off === "function" ? off : () => {
    };
  }
  const register = api.command?.register;
  if (typeof register !== "function") return () => {
  };
  return register.call(api.command, () => [
    {
      title: "\u7ACB\u5373\u5237\u65B0\u5957\u9910\u7528\u91CF",
      value: "quota-refresh",
      description: "\u7ACB\u5373\u91CD\u65B0\u62C9\u53D6\u5F53\u524D provider \u7684\u5957\u9910\u7528\u91CF",
      category: "Quota",
      slash: { name: "quota-refresh" },
      onSelect: refresh
    }
  ]);
}
function whenRendererReady(api, run) {
  if (api.renderer?.isRunning) {
    run();
    return () => {
    };
  }
  const poll = setInterval(() => {
    if (api.renderer?.isRunning) {
      clearInterval(poll);
      clearTimeout(fallback);
      run();
    }
  }, 50);
  const fallback = setTimeout(() => {
    clearInterval(poll);
    run();
  }, 1500);
  return () => {
    clearInterval(poll);
    clearTimeout(fallback);
  };
}
var tui = async (api, options) => {
  try {
    let activeAdapter2 = function(sessionID2) {
      const messages = sessionID2 ? api.state.session.messages(sessionID2) : [];
      const active = resolveActiveProvider({ messages, config: api.state.config });
      const byId = active.providerID ? adapterForProviderId(active.providerID) : void 0;
      const fallback = candidates[0];
      const chosen = byId && candidates.includes(byId) ? byId : byId ?? fallback;
      return chosen;
    };
    var activeAdapter = activeAdapter2;
    trace(`setup \u5F00\u59CB renderer.isRunning=${String(api.renderer?.isRunning)}`);
    const opts = readOptions(options);
    const intervalMs = Math.max(15e3, opts.intervalMs ?? 6e4);
    const providers = hostProviders(api);
    trace(`hostProviders: ${providers.length} \u4E2A`);
    const allowed = opts.providers;
    const candidates = availableAdapters(providers).filter(
      (a) => !allowed || allowed.length === 0 || allowed.some((n) => n === a.id || n === a.label)
    );
    const [snapshot, setSnapshot] = createSignal2(null);
    const [title, setTitle] = createSignal2(opts.title ?? "\u5957\u9910\u7528\u91CF");
    const [refreshTick, setRefreshTick] = createSignal2(0);
    let lastFetch = 0;
    let inFlight = false;
    async function load(sessionID2, force) {
      const now = Date.now();
      if (!force && now - lastFetch < intervalMs - 1e3) return;
      if (inFlight) return;
      const adapter = activeAdapter2(sessionID2);
      if (!adapter) {
        trace("load\uFF1A\u672A\u627E\u5230\u53EF\u7528 adapter");
        setSnapshot({ provider: "\u2014", ok: false, error: "\u672A\u627E\u5230\u53EF\u7528\u7684\u5957\u9910 provider", fetchedAt: now });
        return;
      }
      inFlight = true;
      lastFetch = now;
      try {
        const quota = await fetchQuota(adapter, providers);
        trace(`load \u6210\u529F provider=${adapter.label} windows=${quota.windows.length} extras=${quota.extras.length}`);
        setSnapshot({ provider: adapter.label, ok: true, quota, fetchedAt: now });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        trace(`load \u5931\u8D25 provider=${adapter.label} err=${msg}`);
        setSnapshot({
          provider: adapter.label,
          ok: false,
          error: msg,
          fetchedAt: now
        });
      } finally {
        inFlight = false;
      }
    }
    let sessionID;
    const render = (slotProps) => {
      const props = asRecord3(slotProps);
      const next = typeof props?.session_id === "string" ? props.session_id : sessionID;
      if (next !== sessionID) {
        sessionID = next;
        setTitle(`${activeAdapter2(sessionID)?.label ?? "\u5957\u9910"} \u989D\u5EA6`);
        void load(sessionID, true);
      }
      trace(`render \u88AB\u8C03\u7528 session=${next ?? "(none)"}`);
      return createComponent(QuotaPanel, {
        snapshot,
        title,
        theme: api.theme,
        kv: api.kv,
        refreshSignal: refreshTick,
        version: PLUGIN_VERSION
      });
    };
    const stopReady = whenRendererReady(api, () => {
      const { ok, dispose } = registerSidebarSlot(api, render);
      if (!ok) {
        api.ui.toast({ variant: "error", message: "quota-switch: \u672A\u80FD\u6CE8\u518C sidebar \u63D2\u69FD" });
      } else if (dispose) {
        api.lifecycle.onDispose(dispose);
      }
      setTitle(`${activeAdapter2(sessionID)?.label ?? "\u5957\u9910"} \u989D\u5EA6`);
      void load(sessionID, true);
    });
    const offRefresh = registerRefreshCommand(api, () => {
      setRefreshTick(Date.now());
      void load(sessionID, true);
    });
    trace(`\u51C6\u5907\u6CE8\u518C\uFF0Ccandidates=${candidates.map((c) => c.id).join(",") || "(\u65E0)"}`);
    const offs = [
      api.event.on("message.updated", () => void load(sessionID, false)),
      api.event.on("session.updated", () => void load(sessionID, false)),
      api.event.on("session.idle", () => void load(sessionID, true))
    ].filter((off) => typeof off === "function");
    const timer = setInterval(() => void load(sessionID, false), intervalMs);
    api.lifecycle.onDispose(() => {
      clearInterval(timer);
      stopReady();
      offRefresh();
      offs.forEach((off) => off());
    });
    trace("setup \u8D70\u5B8C\uFF0C\u672A\u629B\u5F02\u5E38");
  } catch (e) {
    trace(`setup \u629B\u5F02\u5E38: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    throw e;
  }
};
var main_default = { id: "quota-switch", tui, setup: tui };
export {
  main_default as default
};
