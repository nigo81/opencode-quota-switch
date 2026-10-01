// main.ts
import { createSignal as createSignal2 } from "solid-js";
import { createComponent } from "@opentui/solid";
import fs2 from "node:fs";

// src/active-provider.ts
function rec(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function shapeOf(v, depth = 0) {
  if (v === null) return "null";
  if (v === void 0) return "undefined";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `array(${v.length})<${shapeOf(v[0], depth + 1)}>`;
  }
  if (typeof v === "function") return "function";
  if (typeof v !== "object") return typeof v;
  if (depth >= 2) return "{\u2026}";
  return `{${Object.keys(v).slice(0, 12).map((k) => `${k}:${shapeOf(v[k], depth + 1)}`).join(",")}}`;
}
function pickProviderIDFromModelLike(m) {
  const r = rec(m);
  if (!r) return void 0;
  for (const key of ["providerID", "providerId", "provider_id"]) {
    const v = r[key];
    if (typeof v === "string" && v !== "") return v;
  }
  const info = rec(r.info);
  if (info) {
    for (const key of ["providerID", "providerId"]) {
      const v = info[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  for (const key of ["modelID", "modelId", "id"]) {
    const v = r[key];
    if (typeof v === "string" && v.includes("/")) return v.split("/")[0];
  }
  return void 0;
}
function providerIDFromMessages(messages) {
  if (!Array.isArray(messages)) return void 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = rec(messages[i]);
    if (!r) continue;
    const direct = pickProviderIDFromModelLike(r);
    if (direct) return direct;
    const info = rec(r.info);
    if (info) {
      const v = pickProviderIDFromModelLike(info);
      if (v) return v;
    }
  }
  return void 0;
}
async function detectActiveProvider(api, preferIDs = []) {
  const notes = [];
  for (const id of preferIDs) {
    if (typeof id === "string" && id !== "") {
      notes.push(`render props \u76F4\u63A5\u7ED9\u51FA ${id}`);
      return { providerID: id, notes };
    }
  }
  const a = rec(api) ?? {};
  const ui = rec(a.ui) ?? {};
  const client = rec(a.client) ?? {};
  const uiModel = rec(ui.model) ?? {};
  for (const key of ["current", "selected", "active", "value"]) {
    const id = pickProviderIDFromModelLike(uiModel[key]);
    if (id) {
      notes.push(`api.ui.model.${key} \u2192 ${id}`);
      return { providerID: id, notes };
    }
  }
  notes.push(`api.ui.model \u6210\u5458=[${Object.keys(uiModel).join(",")}] \u65E0 current/selected`);
  const sessionNS = rec(client.session) ?? {};
  try {
    const listFn = sessionNS.list;
    if (typeof listFn === "function") {
      const list = await listFn.call(sessionNS);
      const arr = Array.isArray(list) ? list : rec(list)?.data ?? [];
      const first = rec(arr[0]);
      const infoRec = rec(first?.info);
      const sid = first?.id ?? first?.sessionID ?? infoRec?.id;
      if (typeof sid === "string") {
        const getFn = sessionNS.get;
        if (typeof getFn === "function") {
          const s = await getFn.call(sessionNS, sid);
          const id = providerIDFromMessages(rec(s)?.messages);
          if (id) {
            notes.push(`api.client.session.get(${sid}) \u6700\u8FD1\u6D88\u606F \u2192 ${id}`);
            return { providerID: id, notes };
          }
          notes.push(`api.client.session.get(${sid}) \u6D88\u606F\u91CC\u6CA1\u6709 providerID\uFF08shape=${shapeOf(s)}\uFF09`);
        }
      } else {
        notes.push(`api.client.session.list() \u62FF\u4E0D\u5230 session id\uFF08shape=${shapeOf(list)}\uFF09`);
      }
    } else {
      notes.push(`api.client.session \u65E0 list()\uFF0C\u6210\u5458=[${Object.keys(sessionNS).join(",")}]`);
    }
  } catch (e) {
    notes.push(`api.client.session \u629B\u5F02\u5E38: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const dataSession = rec(rec(a.data)?.session) ?? {};
    for (const key of Object.keys(dataSession)) {
      const v = dataSession[key];
      if (typeof v === "function" && key !== "get" && key !== "select") {
        const r = await v.call(dataSession);
        const id = pickProviderIDFromModelLike(r) ?? providerIDFromMessages(r);
        if (id) {
          notes.push(`api.data.session.${key}() \u2192 ${id}`);
          return { providerID: id, notes };
        }
      }
    }
    notes.push(`api.data.session \u6210\u5458=[${Object.keys(dataSession).join(",")}] \u672A\u547D\u4E2D`);
  } catch (e) {
    notes.push(`api.data.session \u629B\u5F02\u5E38: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const modelNS = rec(client.model) ?? {};
    const listFn = modelNS.list ?? modelNS.available;
    if (typeof listFn === "function") {
      const list = await listFn.call(modelNS);
      const arr = Array.isArray(list) ? list : [];
      const ids = /* @__PURE__ */ new Set();
      for (const m of arr) {
        const id = pickProviderIDFromModelLike(m);
        if (id) ids.add(id);
      }
      notes.push(`api.client.model \u5217\u8868\u91CC\u51FA\u73B0\u7684 providerID=[${[...ids].join(",")}]\uFF08\u65E0\u300C\u5F53\u524D\u300D\u8BED\u4E49\uFF0C\u4EC5\u4F9B\u5BF9\u7167\uFF09`);
    }
  } catch (e) {
    notes.push(`api.client.model \u629B\u5F02\u5E38: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { notes };
}

// src/authfile.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function candidatePaths() {
  const paths = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "auth.json")
  ];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) paths.push(path.join(xdg, "opencode", "auth.json"));
  return paths;
}
var cache = null;
var TTL_MS = 3e4;
function readAuthFile() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  let result = { list: [], from: "(\u672A\u627E\u5230 auth.json)" };
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const list = [];
      for (const [id, value] of Object.entries(raw)) {
        const entry = value;
        if (entry === null || typeof entry !== "object") continue;
        if (entry.type !== void 0 && entry.type !== "api") continue;
        if (typeof entry.key !== "string" || entry.key.trim() === "") continue;
        list.push({ id, apiKey: entry.key });
      }
      if (list.length > 0) {
        result = { list, from: p };
        break;
      }
    } catch {
    }
  }
  cache = { at: now, ...result };
  return result;
}
function authFileProviders() {
  return readAuthFile().list;
}
function authFileTrace() {
  const { list, from } = readAuthFile();
  return `${from} \u2192 [${list.map((p) => p.id).join(",") || "(\u7A7A)"}]`;
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
function asRecord(v) {
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
function strField(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" ? v : void 0;
}
function limitsOf(data) {
  const raw = data.limits;
  if (!Array.isArray(raw)) return [];
  return raw.map(asRecord);
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
  const root = asRecord(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  if (root.is_available === false) throw new Error("\u8D26\u53F7\u4E0D\u53EF\u7528");
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos.map(asRecord).filter((r) => r != null) : [];
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
  const root = asRecord(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  if (root.success === false) throw new Error(strField(root, "msg") ?? "\u63A5\u53E3\u8FD4\u56DE\u5931\u8D25");
  const data = asRecord(root.data) ?? root;
  const windows = glmWindows(data);
  if (!windows.length) throw new Error("\u54CD\u5E94\u4E2D\u65E0 TOKENS_LIMIT/CREDIT_LIMIT \u7A97\u53E3");
  return { level: strField(data, "level"), windows, extras: [] };
}

// src/providers/glm.ts
var isGlm = (p) => matchesAny(p.baseURL ?? "", ["open.bigmodel.cn", "api.z.ai"]) || matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["zhipu", "bigmodel", "z.ai"]);
var isGlmCoding = (p) => (p.baseURL ?? "").includes("/coding/");
var GLM_DEFAULT_ORIGIN = "https://open.bigmodel.cn";
async function fetchGlm(p) {
  if (!p.apiKey) throw new Error("GLM provider \u7F3A\u5C11 apiKey");
  const origin = p.baseURL ? hostOf(p.baseURL) : GLM_DEFAULT_ORIGIN;
  const json = await getJson(`${origin}/api/monitor/usage/quota/limit`, {
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
  const unit = strField(win, "timeUnit") ?? "";
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
  const usage = asRecord(root.usage);
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
    const detail = asRecord(item?.detail) ?? item;
    const limit = toNum(detail?.limit);
    const used = kimiUsed(detail, limit);
    windows.push({
      label: kimiWindowLabel(asRecord(item?.window)),
      usedPct: pctOf(used, limit),
      used,
      limit,
      resetLabel: formatReset(detail?.resetTime ?? detail?.reset_at)
    });
  }
  return windows;
}
function kimiExtras(root) {
  const cents = toNum(asRecord(asRecord(root.boosterWallet)?.monthlyUsed)?.priceInCents);
  if (cents == null) return [];
  return [{ label: "\u6708\u6D88", value: `\xA5${(cents / 100).toFixed(2)}` }];
}
function stripLevelPrefix(level) {
  if (level == null) return void 0;
  return level.startsWith("LEVEL_") ? level.slice("LEVEL_".length) : level;
}
function parseKimiQuota(json) {
  const root = asRecord(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  const windows = kimiWindows(root);
  if (!windows.length) throw new Error("\u54CD\u5E94\u4E2D\u65E0 usage/limits \u7A97\u53E3");
  sortByDisplayOrder(windows);
  const level = strField(asRecord(asRecord(root.user)?.membership), "level");
  return { level: stripLevelPrefix(level), windows, extras: kimiExtras(root) };
}

// src/providers/kimi.ts
var isKimi = (p) => matchesAny(p.baseURL ?? "", ["api.kimi.com/coding"]) || matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["kimi-for-coding", "kimi", "moonshot"]);
var KIMI_DEFAULT_BASE = "https://api.kimi.com/coding/v1";
async function fetchKimi(p) {
  if (!p.apiKey) throw new Error("Kimi provider \u7F3A\u5C11 apiKey");
  const base = p.baseURL ? trimSlashes(p.baseURL) : KIMI_DEFAULT_BASE;
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
  const byName = (pred) => entries.find((e) => pred(strField(e, "model_name") ?? ""));
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
  const name = strField(entry, "model_name");
  if (name == null || !/^minimax-m/i.test(name)) return void 0;
  return name;
}
function parseMinimaxQuota(json) {
  const root = asRecord(json);
  if (!root) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
  const baseResp = asRecord(root.base_resp);
  const code = toNum(baseResp?.status_code);
  if (code != null && code !== 0) {
    throw new Error(strField(baseResp, "status_msg") ?? `\u63A5\u53E3\u8FD4\u56DE\u5931\u8D25\uFF08status_code=${code}\uFF09`);
  }
  const raw = root.model_remains;
  const entries = Array.isArray(raw) ? raw.map(asRecord).filter((e) => e != null) : [];
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
  void adapter;
  return nonEmpty(p?.apiKey);
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
    fs2.appendFileSync(TRACE_FILE, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
  }
}
trace(`=== \u6A21\u5757\u52A0\u8F7D (pid=${process.pid}) ===`);
function readOptions(raw) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  const str = (v) => typeof v === "string" ? v : void 0;
  const list = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
  return { providers: list(raw?.providers), intervalMs: num(raw?.intervalMs), title: str(raw?.title) };
}
function asRecord2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function hostProviders(api) {
  return () => {
    const list = api.state?.provider;
    const fromHost = Array.isArray(list) ? list.map((p) => {
      const rec2 = asRecord2(p);
      const options = asRecord2(rec2?.options);
      const id = rec2?.id;
      const name = rec2?.name;
      const baseURL = options?.baseURL;
      const apiKey = options?.apiKey;
      return {
        id: typeof id === "string" ? id : void 0,
        name: typeof name === "string" ? name : void 0,
        baseURL: typeof baseURL === "string" ? baseURL : void 0,
        apiKey: typeof apiKey === "string" ? apiKey : void 0
      };
    }) : [];
    const merged = [...fromHost];
    for (const entry of authFileProviders()) {
      const existing = merged.find((p) => p.id === entry.id);
      if (!existing) merged.push(entry);
      else if (!existing.apiKey) existing.apiKey = entry.apiKey;
    }
    return merged;
  };
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
    try {
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
      trace("\u547D\u4EE4\u6CE8\u518C\u6210\u529F\uFF1A/quota-refresh");
      return typeof off === "function" ? off : () => {
      };
    } catch (e) {
      trace(`keymap.layer \u629B\u5F02\u5E38\uFF0C\u964D\u7EA7\uFF08\u4E0D\u5F71\u54CD\u81EA\u52A8\u5237\u65B0\uFF09: ${e instanceof Error ? e.message : String(e)}`);
      return () => {
      };
    }
  }
  const register = api.command?.register;
  if (typeof register !== "function") return () => {
  };
  try {
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
  } catch (e) {
    trace(`command.register \u629B\u5F02\u5E38\uFF0C\u964D\u7EA7: ${e instanceof Error ? e.message : String(e)}`);
    return () => {
    };
  }
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
    let activeAdapter2 = function() {
      const list = candidates();
      const byId = detectedProviderID ? adapterForProviderId(detectedProviderID) : void 0;
      if (byId && list.includes(byId)) return byId;
      if (byId) return byId;
      return list[0];
    }, panelTitle2 = function() {
      return `${activeAdapter2()?.label ?? "\u5957\u9910"} Quota`;
    }, scheduleRetry2 = function() {
      if (retryCount >= 6) return;
      const delay = Math.min(4e3, 300 * 2 ** retryCount);
      retryCount += 1;
      setTimeout(() => void load(true), delay);
    };
    var activeAdapter = activeAdapter2, panelTitle = panelTitle2, scheduleRetry = scheduleRetry2;
    trace(`setup \u5F00\u59CB renderer=${String(api.renderer?.isRunning)}`);
    trace(`api \u6210\u5458: ${Object.keys(api).join(",")}`);
    trace(
      `api \u5B50\u6210\u5458: ui=[${Object.keys(api.ui ?? {}).join(",")}] slots=[${Object.keys(api.slots ?? {}).join(",")}]`
    );
    for (const key of ["data", "options", "keymap", "client", "storage", "model"]) {
      const v = api[key];
      const kind = v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v;
      const sub = v !== null && typeof v === "object" ? `[${Object.keys(v).slice(0, 20).join(",")}]` : "";
      trace(`  api.${key} = ${kind}${sub}`);
    }
    const opts = readOptions(options);
    const intervalMs = Math.max(15e3, opts.intervalMs ?? 6e4);
    const getProviders = hostProviders(api);
    const allowed = opts.providers;
    const candidates = () => availableAdapters(getProviders()).filter(
      (a) => !allowed || allowed.length === 0 || allowed.some((n) => n === a.id || n === a.label)
    );
    const [snapshot, setSnapshot] = createSignal2(null);
    const [title, setTitle] = createSignal2(opts.title ?? "\u5957\u9910\u7528\u91CF");
    const [refreshTick, setRefreshTick] = createSignal2(0);
    let detectedProviderID;
    let probeInFlight = false;
    async function refreshActiveProvider() {
      if (probeInFlight) return;
      probeInFlight = true;
      try {
        const r = await detectActiveProvider(api);
        r.notes.forEach((n) => trace(`  \u63A2\u6D4B: ${n}`));
        if (r.providerID !== detectedProviderID) {
          trace(`\u6D3B\u8DC3 provider: ${detectedProviderID ?? "(\u65E0)"} \u2192 ${r.providerID ?? "(\u4ECD\u672A\u63A2\u5230)"}`);
          detectedProviderID = r.providerID;
        }
      } catch (e) {
        trace(`\u63A2\u6D4B\u6D3B\u8DC3 provider \u629B\u5F02\u5E38: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      } finally {
        probeInFlight = false;
      }
    }
    let lastFetch = 0;
    let inFlight = false;
    let retryCount = 0;
    async function load(force) {
      const now = Date.now();
      if (!force && now - lastFetch < intervalMs - 1e3) return;
      if (inFlight) return;
      await refreshActiveProvider();
      const adapter = activeAdapter2();
      if (!adapter) {
        trace(`load\uFF1A\u672A\u627E\u5230\u53EF\u7528 adapter\uFF08\u7B2C ${retryCount} \u6B21\uFF0C\u5C06\u91CD\u8BD5\uFF09`);
        setSnapshot({ provider: "\u2014", ok: false, error: "\u672A\u627E\u5230\u53EF\u7528\u7684\u5957\u9910 provider", fetchedAt: now });
        scheduleRetry2();
        return;
      }
      retryCount = 0;
      inFlight = true;
      lastFetch = now;
      try {
        const quota = await fetchQuota(adapter, getProviders());
        trace(`load \u6210\u529F provider=${adapter.label} windows=${quota.windows.length} extras=${quota.extras.length}`);
        setTitle(panelTitle2());
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
      const props = asRecord2(slotProps);
      const next = typeof props?.session_id === "string" ? props.session_id : sessionID;
      if (next !== sessionID) {
        sessionID = next;
        trace(`render \u88AB\u8C03\u7528 session=${next ?? "(none)"}`);
        setTitle(panelTitle2());
        void load(true);
      }
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
      const { ok, dispose: dispose2 } = registerSidebarSlot(api, render);
      if (!ok) {
        guard("toast", () => api.ui.toast({ variant: "error", message: "quota-switch: \u672A\u80FD\u6CE8\u518C sidebar \u63D2\u69FD" }));
      } else if (dispose2) {
        guard("onDispose(dispose)", () => api.lifecycle.onDispose(dispose2));
      }
      guard("setTitle", () => setTitle(panelTitle2()));
      void load(true);
    });
    const offRefresh = registerRefreshCommand(api, () => {
      setRefreshTick(Date.now());
      void load(true);
    });
    trace(`\u51C6\u5907\u6CE8\u518C\uFF0Ccandidates=${candidates().map((c) => c.id).join(",") || "(\u65E0)"}`);
    trace(`\u51ED\u8BC1\u6765\u6E90 auth.json: ${authFileTrace()}`);
    trace(`\u5408\u5E76\u540E provider \u6761\u76EE: ${getProviders().map((p) => `${p.id}${p.baseURL ? "(\u6709baseURL)" : ""}`).join(",") || "(\u65E0)"}`);
    const dataNS = asRecord2(asRecord2(api)?.data);
    const dataOn = dataNS?.on;
    const offs = (guard(
      "data.on",
      () => typeof dataOn === "function" ? [
        dataOn.call(dataNS, "message.updated", () => void load(false)),
        dataOn.call(dataNS, "session.updated", () => void load(false)),
        dataOn.call(dataNS, "session.idle", () => void load(true))
      ] : []
    ) ?? []).filter((off) => typeof off === "function");
    const timer = setInterval(() => void load(false), intervalMs);
    const watchTimer = setInterval(() => {
      void (async () => {
        const before = detectedProviderID;
        await refreshActiveProvider();
        if (detectedProviderID !== before) {
          setTitle(panelTitle2());
          void load(true);
        }
      })();
    }, 3e3);
    const dispose = () => {
      clearInterval(timer);
      clearInterval(watchTimer);
      stopReady();
      offRefresh();
      offs.forEach((off) => off());
    };
    for (const [obj, path2] of [
      [api, "api.lifecycle.onDispose"],
      [asRecord2(api)?.app, "api.app.onDispose"],
      [asRecord2(api)?.renderer, "api.renderer.onDispose"]
    ]) {
      const fn = obj?.onDispose;
      if (typeof fn === "function") {
        guard(path2, () => fn.call(obj, dispose));
        break;
      }
    }
    trace(`setup \u8D70\u5B8C\uFF0C\u672A\u629B\u5F02\u5E38\uFF08offs=${offs.length} timer=${intervalMs}ms watch=3000ms\uFF09`);
  } catch (e) {
    trace(`setup \u629B\u5F02\u5E38\uFF08\u5DF2\u541E\u6389\uFF0C\u4E0D\u5F71\u54CD\u5DF2\u6CE8\u518C\u7684\u69FD\u4F4D\uFF09: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
};
function guard(label, fn) {
  try {
    return fn();
  } catch (e) {
    trace(`${label} \u629B\u5F02\u5E38\uFF0C\u5DF2\u8DF3\u8FC7: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return void 0;
  }
}
var main_default = { id: "quota-switch", tui, setup: tui };
export {
  main_default as default
};
