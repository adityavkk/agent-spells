/**
 * Floating footer for pi.
 *
 * Opencode-inspired footer surface:
 * - profile-aware model resolution for synthetic `profiles/<profile:role>` models
 * - darker footer band with subtle divider and padding
 * - shows active profile status alongside concrete provider/model
 * - quota bars follow the resolved concrete provider
 */

import type { Model } from "@mariozechner/pi-ai";
import { CustomEditor, buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadModelProfilesConfig } from "../model-profiles/config";
import { buildSyntheticProfileModelId, parseSyntheticProfileModelId } from "../model-profiles/provider";
import { expandRoleCandidates, getRoleTargets } from "../model-profiles/resolve";
import { getModelProfilesSelectionKey, readModelProfilesRuntimeState } from "../model-profiles/state";
import { MODEL_PROFILES_PROVIDER } from "../model-profiles/types";

interface RateWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string;
}

interface UsageSnapshot {
  provider: string;
  windows: RateWindow[];
  error?: string;
  fetchedAt: number;
}

interface GitCache {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

interface FooterModelResolution {
  logicalStatus?: string;
  actualModel?: Model<any>;
}

interface FloatingComposerThemeTokens {
  panelBg: string;
}

const USAGE_REFRESH_INTERVAL = 5 * 60_000;
const usageCache = new Map<string, UsageSnapshot>();

let gitCache: GitCache | null = null;

function sanitizeStatusText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
  return clean.length > 0 ? clean : undefined;
}

function parseGitStatus(output: string): GitCache {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head : null;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = parseInt(match[1], 10) || 0;
        behind = parseInt(match[2], 10) || 0;
      }
      continue;
    }

    if (!line.startsWith("# ")) dirty = true;
  }

  return { branch, dirty, ahead, behind };
}

function sameGitCache(a: GitCache | null, b: GitCache | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;
}

function refreshGitCache(): boolean {
  let next: GitCache | null = null;

  try {
    const status = execSync("git status --porcelain=v2 --branch 2>/dev/null", {
      encoding: "utf8",
      timeout: 1000,
    });
    next = parseGitStatus(status.trimEnd());
  } catch {
    next = null;
  }

  const changed = !sameGitCache(gitCache, next);
  gitCache = next;
  return changed;
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function loadAuthJson(): Record<string, any> {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {}
  return {};
}

function resolveAuthValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("!")) {
    try {
      const output = execSync(trimmed.slice(1), {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 2000,
      }).trim();
      return output || undefined;
    } catch {
      return undefined;
    }
  }

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && process.env[trimmed]) {
    return process.env[trimmed];
  }

  return trimmed;
}

function getApiKey(providerKey: string, envVar: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];

  const auth = loadAuthJson();
  const entry = auth[providerKey];
  if (!entry) return undefined;

  if (typeof entry === "string") {
    return resolveAuthValue(entry);
  }

  return resolveAuthValue(entry.key ?? entry.access ?? entry.refresh);
}

function getClaudeToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth.anthropic?.access) return auth.anthropic.access;

  try {
    const keychainData = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (keychainData) {
      const parsed = JSON.parse(keychainData);
      if (parsed.claudeAiOauth?.accessToken) {
        return parsed.claudeAiOauth.accessToken;
      }
    }
  } catch {}

  return undefined;
}

function getCopilotToken(): string | undefined {
  const auth = loadAuthJson();
  return auth["github-copilot"]?.refresh;
}

function getCodexToken(): { token: string; accountId?: string } | undefined {
  const auth = loadAuthJson();
  if (auth["openai-codex"]?.access) {
    return { token: auth["openai-codex"].access, accountId: auth["openai-codex"]?.accountId };
  }

  const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  try {
    if (existsSync(codexPath)) {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      if (data.OPENAI_API_KEY) {
        return { token: data.OPENAI_API_KEY };
      }
      if (data.tokens?.access_token) {
        return { token: data.tokens.access_token, accountId: data.tokens.account_id };
      }
    }
  } catch {}

  return undefined;
}

function getGeminiToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth["google-gemini-cli"]?.access) return auth["google-gemini-cli"].access;

  const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
  try {
    if (existsSync(geminiPath)) {
      const data = JSON.parse(readFileSync(geminiPath, "utf-8"));
      return data.access_token;
    }
  } catch {}

  return undefined;
}

function getMinimaxToken(provider: "minimax" | "minimax-cn"): string | undefined {
  return provider === "minimax"
    ? getApiKey("minimax", "MINIMAX_API_KEY")
    : getApiKey("minimax-cn", "MINIMAX_CN_API_KEY");
}

function formatResetTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 && value >= 0 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function getWindowLabel(durationMs: number | undefined, fallback: string): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;

  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  const isCloseToWeek = Math.abs(durationMs - weekMs) <= hourMs * 2;
  const isCloseToDay = Math.abs(durationMs - dayMs) <= hourMs * 2;
  const isCloseTo5h = Math.abs(durationMs - 5 * hourMs) <= hourMs * 2;

  if (isCloseToWeek || fallback === "Week") return "Week";
  if (isCloseToDay || fallback === "Day") return "Day";
  if (isCloseTo5h || fallback === "5h") return fallback;

  const hours = Math.round(durationMs / hourMs);
  if (hours >= 1 && hours < 48) return `${hours}h`;

  const days = Math.round(durationMs / dayMs);
  if (days >= 1) return `${days}d`;

  const mins = Math.max(1, Math.round(durationMs / 60000));
  return `${mins}m`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
  const token = getClaudeToken();
  if (!token) {
    return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!res.ok) {
      return { provider: "Claude", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.five_hour?.utilization !== undefined) {
      windows.push({
        label: "5h",
        usedPercent: normalizePercent(data.five_hour.utilization),
        resetsIn: data.five_hour.resets_at ? formatResetTime(new Date(data.five_hour.resets_at)) : undefined,
      });
    }

    if (data.seven_day?.utilization !== undefined) {
      windows.push({
        label: "Week",
        usedPercent: normalizePercent(data.seven_day.utilization),
        resetsIn: data.seven_day.resets_at ? formatResetTime(new Date(data.seven_day.resets_at)) : undefined,
      });
    }

    return { provider: "Claude", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Claude", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
  const token = getCopilotToken();
  if (!token) {
    return { provider: "Copilot", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
      headers: {
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        Accept: "application/json",
        Authorization: `token ${token}`,
      },
    });

    if (!res.ok) {
      return { provider: "Copilot", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
    const resetsIn = resetDate ? formatResetTime(resetDate) : undefined;

    if (data.quota_snapshots?.premium_interactions) {
      const pi = data.quota_snapshots.premium_interactions;
      const usedPercent = clampPercent(100 - (pi.percent_remaining || 0));
      windows.push({ label: "Premium", usedPercent, resetsIn });
    }

    if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
      const chat = data.quota_snapshots.chat;
      windows.push({
        label: "Chat",
        usedPercent: clampPercent(100 - (chat.percent_remaining || 0)),
        resetsIn,
      });
    }

    return { provider: "Copilot", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Copilot", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
  const creds = getCodexToken();
  if (!creds) {
    return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "User-Agent": "pi-agent",
      Accept: "application/json",
    };

    if (creds.accountId) {
      headers["ChatGPT-Account-Id"] = creds.accountId;
    }

    const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      return { provider: "Codex", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.rate_limit?.primary_window) {
      const pw = data.rate_limit.primary_window;
      const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
      const durationMs = typeof pw.limit_window_seconds === "number" ? pw.limit_window_seconds * 1000 : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent: clampPercent(pw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    if (data.rate_limit?.secondary_window) {
      const sw = data.rate_limit.secondary_window;
      const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
      const durationMs = typeof sw.limit_window_seconds === "number" ? sw.limit_window_seconds * 1000 : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent: clampPercent(sw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    return { provider: "Codex", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Codex", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
  const token = getGeminiToken();
  if (!token) {
    return { provider: "Gemini", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });

    if (!res.ok) {
      return { provider: "Gemini", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const quotas: Record<string, number> = {};

    for (const bucket of data.buckets || []) {
      const model = bucket.modelId || "unknown";
      const frac = bucket.remainingFraction ?? 1;
      if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
    }

    const windows: RateWindow[] = [];
    let proMin = 1;
    let flashMin = 1;
    let hasProModel = false;
    let hasFlashModel = false;

    for (const [model, frac] of Object.entries(quotas)) {
      if (model.toLowerCase().includes("pro")) {
        hasProModel = true;
        if (frac < proMin) proMin = frac;
      }
      if (model.toLowerCase().includes("flash")) {
        hasFlashModel = true;
        if (frac < flashMin) flashMin = frac;
      }
    }

    if (hasProModel) windows.push({ label: "Pro", usedPercent: clampPercent((1 - proMin) * 100) });
    if (hasFlashModel) windows.push({ label: "Flash", usedPercent: clampPercent((1 - flashMin) * 100) });

    return { provider: "Gemini", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Gemini", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchMinimaxUsage(provider: "minimax" | "minimax-cn"): Promise<UsageSnapshot> {
  const token = getMinimaxToken(provider);
  const providerLabel = provider === "minimax-cn" ? "MiniMax CN" : "MiniMax";
  const endpoint = provider === "minimax-cn"
    ? "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"
    : "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

  if (!token) {
    return { provider: providerLabel, windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return { provider: providerLabel, windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const baseResp = data?.base_resp;
    if (baseResp?.status_code && baseResp.status_code !== 0) {
      return {
        provider: providerLabel,
        windows: [],
        error: baseResp.status_msg || `API ${baseResp.status_code}`,
        fetchedAt: Date.now(),
      };
    }

    const remains = Array.isArray(data?.model_remains) ? data.model_remains : [];
    const textBucket =
      remains.find((entry: any) => typeof entry?.model_name === "string" && /^minimax-m/i.test(entry.model_name))
      || remains.find((entry: any) => typeof entry?.model_name === "string" && /minimax/i.test(entry.model_name))
      || remains[0];

    if (!textBucket) {
      return { provider: providerLabel, windows: [], error: "no-usage-data", fetchedAt: Date.now() };
    }

    const windows: RateWindow[] = [];

    const intervalTotal = Number(textBucket.current_interval_total_count) || 0;
    const intervalRemaining = Number(textBucket.current_interval_usage_count) || 0;
    if (intervalTotal > 0) {
      const used = intervalTotal - intervalRemaining;
      const usedPercent = clampPercent((used / intervalTotal) * 100);
      const resetDate = textBucket.end_time ? new Date(Number(textBucket.end_time)) : undefined;
      const durationMs = textBucket.start_time && textBucket.end_time
        ? Number(textBucket.end_time) - Number(textBucket.start_time)
        : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    const weeklyTotal = Number(textBucket.current_weekly_total_count) || 0;
    const weeklyRemaining = Number(textBucket.current_weekly_usage_count) || 0;
    if (weeklyTotal > 0) {
      const used = weeklyTotal - weeklyRemaining;
      const usedPercent = clampPercent((used / weeklyTotal) * 100);
      const resetDate = textBucket.weekly_end_time ? new Date(Number(textBucket.weekly_end_time)) : undefined;
      const durationMs = textBucket.weekly_start_time && textBucket.weekly_end_time
        ? Number(textBucket.weekly_end_time) - Number(textBucket.weekly_start_time)
        : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: providerLabel, windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "openai-codex": "codex",
  "github-copilot": "copilot",
  "google-gemini-cli": "gemini",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
};

function detectProvider(modelProvider: string | undefined): string | null {
  if (!modelProvider) return null;
  return PROVIDER_MAP[modelProvider] || null;
}

async function fetchUsageForProvider(provider: string): Promise<UsageSnapshot> {
  switch (provider) {
    case "claude":
      return fetchClaudeUsage();
    case "codex":
      return fetchCodexUsage();
    case "copilot":
      return fetchCopilotUsage();
    case "gemini":
      return fetchGeminiUsage();
    case "minimax":
      return fetchMinimaxUsage("minimax");
    case "minimax-cn":
      return fetchMinimaxUsage("minimax-cn");
    default:
      return { provider: "Unknown", windows: [], error: "unknown-provider", fetchedAt: Date.now() };
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

function fitFooterSegment(width: number, variants: string[]): string {
  const safeWidth = Math.max(1, width);
  for (const variant of variants) {
    if (visibleWidth(variant) <= safeWidth) return variant;
  }
  return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

function wrapFooterSegments(segments: string[], width: number, sep: string): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";

  for (const segment of segments.filter(Boolean)) {
    const fitted = truncateToWidth(segment, safeWidth);
    if (!current) {
      current = fitted;
      continue;
    }
    const candidate = current + sep + fitted;
    if (visibleWidth(candidate) <= safeWidth) {
      current = candidate;
      continue;
    }
    lines.push(truncateToWidth(current, safeWidth));
    current = fitted;
  }

  if (current) lines.push(truncateToWidth(current, safeWidth));
  return lines;
}

function padPlain(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripBgAnsi(text: string): string {
  return text
    .replace(/\x1b\[48;2;[0-9;]+m/g, "")
    .replace(/\x1b\[48;5;[0-9]+m/g, "")
    .replace(/\x1b\[49m/g, "");
}

function isBlankRenderLine(text: string): boolean {
  return stripAnsi(text).trim().length === 0;
}

/**
 * pi-tui's Editor.render() always emits a top and bottom row filled with
 * `─` characters (painted in the theme's borderMuted color). When scrolled,
 * those rows include a scroll indicator like `─── ↑ 5 more ───`.
 *
 * Detect those rows so we can strip them out and let the composer panel own
 * the entire visual frame instead of inheriting pi's default editor border.
 */
function isEditorBorderLine(text: string): boolean {
  const stripped = stripAnsi(text).trim();
  if (stripped.length === 0) return true;
  if (!stripped.includes("─")) return false;
  // all-hyphens or hyphens with a scroll indicator ("↑ N more" / "↓ N more")
  return /^[─\s]*(?:[↑↓]\s*\d+\s+more\s*)?[─\s]*$/.test(stripped);
}

function parseThemeJsonFile(themePath: string): any | null {
  try {
    if (!themePath || !existsSync(themePath)) return null;
    return JSON.parse(readFileSync(themePath, "utf-8"));
  } catch {
    return null;
  }
}

function resolveThemeVarValue(
  vars: Record<string, string | number> | undefined,
  value: string | number | undefined,
  seen = new Set<string>()
): string | number | undefined {
  if (value === undefined || typeof value === "number" || value === "" || value.startsWith("#")) return value;
  if (!vars || !(value in vars) || seen.has(value)) return value;
  seen.add(value);
  return resolveThemeVarValue(vars, vars[value], seen);
}

function getThemeVarColor(
  theme: any,
  varNames: string[],
  fallback: string
): string {
  const themePath = typeof theme?.sourcePath === "string" ? theme.sourcePath : undefined;
  const parsed = themePath ? parseThemeJsonFile(themePath) : null;
  const vars = parsed?.vars as Record<string, string | number> | undefined;

  for (const varName of varNames) {
    const resolved = resolveThemeVarValue(vars, vars?.[varName]);
    if (typeof resolved === "number" || typeof resolved === "string") return String(resolved);
  }

  return fallback;
}

function getBgAnsi(value: string): string | null {
  if (value === "") return "\x1b[49m";
  if (/^\d+$/.test(value)) return `\x1b[48;5;${value}m`;
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const hex = value.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  return null;
}

function applyBgAnsi(value: string, text: string): string {
  const bgAnsi = getBgAnsi(value);
  if (!bgAnsi) return text;

  // Editor/rendered text can contain full resets (0m) or bg resets (49m).
  // Re-apply the panel background after those resets so the area after the
  // cursor and any trailing padding stays on the composer bg instead of
  // falling back to pi's default grey editor background.
  const withReappliedBg = text
    .replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`)
    .replace(/\x1b\[49m/g, `\x1b[49m${bgAnsi}`);

  return `${bgAnsi}${withReappliedBg}\x1b[49m`;
}

function applyFgAnsi(value: string, text: string): string {
  if (value === "") return `\x1b[39m${text}\x1b[39m`;
  if (/^\d+$/.test(value)) return `\x1b[38;5;${value}m${text}\x1b[39m`;
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const hex = value.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }
  return text;
}

function getFloatingComposerThemeTokens(theme: any): FloatingComposerThemeTokens {
  return {
    panelBg: getThemeVarColor(theme, ["floatingComposerBg", "composerPanelBg", "panelBg"], "#000000"),
  };
}

function paintFooterBand(line: string, width: number, theme: any): string {
  const safeWidth = Math.max(1, width);
  const padded = ` ${truncateToWidth(line, Math.max(0, safeWidth - 2))}`;
  const filled = truncateToWidth(padded + " ".repeat(Math.max(0, safeWidth - visibleWidth(padded))), safeWidth);
  return theme.bg("selectedBg", filled);
}

function renderFooterDivider(width: number, theme: any): string {
  return truncateToWidth(theme.fg("borderMuted", "▔".repeat(Math.max(1, width))), width);
}

function joinFooterSides(left: string, right: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const fittedLeft = truncateToWidth(left, safeWidth);
  const fittedRight = truncateToWidth(right, safeWidth);

  if (!fittedLeft) return [fittedRight];
  if (!fittedRight) return [fittedLeft];

  const leftWidth = visibleWidth(fittedLeft);
  const rightWidth = visibleWidth(fittedRight);

  if (leftWidth + 2 + rightWidth <= safeWidth) {
    return [fittedLeft + " ".repeat(safeWidth - leftWidth - rightWidth) + fittedRight];
  }

  return [fittedLeft, fittedRight];
}

function renderUsageBar(usedPercent: number, barWidth: number, theme: any): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;
  const BAR_FILLED = "━";
  const BAR_EMPTY = "─";

  let color: string;
  if (clamped >= 92) color = "error";
  else if (clamped >= 85) color = "warning";
  else color = "success";

  return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}

function renderContextGauge(
  percentage: number,
  theme: any,
  used?: number,
  total?: number,
  options?: { includeCounts?: boolean; barWidth?: number }
): string {
  const clamped = Math.max(0, Math.min(100, percentage));

  // Color tiers match the old gauge bar: success -> accent -> warning -> error.
  // We color the percentage with these so it replaces the bar's visual cue.
  let color: string;
  if (clamped >= 90) color = "error";
  else if (clamped >= 70) color = "warning";
  else if (clamped >= 50) color = "accent";
  else color = "success";

  const pct = theme.fg(color, `${Math.round(clamped)}%`);
  const showCounts = options?.includeCounts !== false && used !== undefined && !!total;
  if (!showCounts) return pct;

  const counts = theme.fg("dim", `(${formatTokenCount(used)}/${formatTokenCount(total)})`);
  return `${pct} ${counts}`;
}

function renderUsageWindow(
  window: RateWindow,
  theme: any,
  options?: { barWidth?: number; includeReset?: boolean }
): string {
  const dim = (s: string) => theme.fg("dim", s);
  const bar = renderUsageBar(window.usedPercent, Math.max(4, options?.barWidth ?? 10), theme);
  const pct = dim(`${Math.round(window.usedPercent)}%`);
  const timeStr = options?.includeReset === false || !window.resetsIn ? "" : " " + dim(window.resetsIn);
  return `${dim(window.label)} ${bar} ${pct}${timeStr}`;
}

function renderUsageLine(usage: UsageSnapshot, width: number, theme: any, options?: { indent?: string }): string[] {
  if (!usage.windows.length) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const sep = " " + dim(">") + " ";
  const indent = options?.indent ?? "";
  const segments: string[] = [theme.fg("accent", usage.provider)];

  for (const window of usage.windows) {
    segments.push(
      fitFooterSegment(width, [
        renderUsageWindow(window, theme, { barWidth: 10, includeReset: true }),
        renderUsageWindow(window, theme, { barWidth: 8, includeReset: true }),
        renderUsageWindow(window, theme, { barWidth: 8, includeReset: false }),
        renderUsageWindow(window, theme, { barWidth: 6, includeReset: false }),
        renderUsageWindow(window, theme, { barWidth: 4, includeReset: false }),
      ])
    );
  }

  return wrapFooterSegments(segments, Math.max(1, width - visibleWidth(indent)), sep)
    .map((line) => indent + line);
}

function getThinkingLevel(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  return context.thinkingLevel || "off";
}

function getContextInfo(ctx: ExtensionContext, model: Model<any> | undefined): { percentage: number; used: number; total: number } {
  const contextWindow = model?.contextWindow ?? 0;
  if (contextWindow === 0) return { percentage: 0, used: 0, total: 0 };

  const entries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const messages = context.messages;

  const lastAssistant = messages
    .slice()
    .reverse()
    .find((message: any) => message.role === "assistant" && message.stopReason !== "aborted") as any;

  const usage = lastAssistant?.usage;
  if (!usage) return { percentage: 0, used: 0, total: contextWindow };
  const contextTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

  return { percentage: (contextTokens / contextWindow) * 100, used: contextTokens, total: contextWindow };
}

function getSessionBranchEntries(ctx: ExtensionContext): any[] {
  const branch = (ctx.sessionManager as any).getBranch?.();
  return Array.isArray(branch) ? branch : ctx.sessionManager.getEntries();
}

function getConfiguredProfileModel(ctx: ExtensionContext, profile: string, role: string): Model<any> | undefined {
  const loaded = loadModelProfilesConfig(ctx.cwd);
  const profileConfig = loaded.mergedConfig.profiles[profile];
  if (!profileConfig) return undefined;

  const trace: string[] = [];
  const candidateRoles = expandRoleCandidates(profileConfig, role, trace);
  for (const candidateRole of candidateRoles) {
    const targets = getRoleTargets(profileConfig.roles[candidateRole]);
    for (const target of targets) {
      const model = ctx.modelRegistry.find(target.provider, target.model);
      if (model) return model;
    }
  }

  return undefined;
}

function resolveFooterModel(ctx: ExtensionContext, logicalStatus?: string): FooterModelResolution {
  const cleanStatus = sanitizeStatusText(logicalStatus);
  const currentModel = ctx.model;
  if (!currentModel) return { logicalStatus: cleanStatus, actualModel: undefined };

  if (currentModel.provider !== MODEL_PROFILES_PROVIDER) {
    return { logicalStatus: cleanStatus, actualModel: currentModel };
  }

  const selection = parseSyntheticProfileModelId(currentModel.id);
  if (!selection) {
    return { logicalStatus: cleanStatus, actualModel: currentModel };
  }

  const runtimeState = readModelProfilesRuntimeState(getSessionBranchEntries(ctx));
  const selectionKey = getModelProfilesSelectionKey(selection.profile, selection.role);
  const winner = selectionKey ? runtimeState.selections[selectionKey]?.lastWinner : undefined;
  const winnerModel = winner ? ctx.modelRegistry.find(winner.provider, winner.model) : undefined;
  const configuredModel = getConfiguredProfileModel(ctx, selection.profile, selection.role);

  return {
    logicalStatus: cleanStatus ?? buildSyntheticProfileModelId(selection.profile, selection.role),
    actualModel: winnerModel ?? configuredModel ?? currentModel,
  };
}

function formatModelSegment(model: Model<any> | undefined, thinkingLevel: string, theme?: any): string {
  if (!model) return theme ? theme.fg("muted", "no-model") : "no-model";

  const provider = theme ? theme.fg("dim", `${model.provider}/`) : `${model.provider}/`;
  const modelId = theme ? theme.fg("muted", model.id) : model.id;
  let value = `${provider}${modelId}`;

  if (model.reasoning) {
    const thinkingText = thinkingLevel !== "off" ? thinkingLevel : "thinking off";
    value += theme
      ? ` ${theme.fg("dim", ">")} ${theme.fg("dim", thinkingText)}`
      : ` > ${thinkingText}`;
  }

  return value;
}

interface FloatingComposerFooterContent {
  inside: string[];
  outside: string[];
}

type FloatingComposerFooterRenderer = (innerWidth: number, outerWidth: number) => FloatingComposerFooterContent;

class FloatingComposerEditor extends CustomEditor {
  private footerRenderer: FloatingComposerFooterRenderer | null = null;
  private footerTheme: any = null;

  setFooterRenderer(renderer: FloatingComposerFooterRenderer | null, theme: any): void {
    this.footerRenderer = renderer;
    this.footerTheme = theme;
  }

  render(width: number): string[] {
    const theme = this.footerTheme;
    const padLeft = 2;
    const padRight = 2;
    const borderWidth = 1;

    // opencode composer: panel is full-width with no outer margin. At very
    // wide terminals leave one column of breathing room on each side so it
    // doesn't feel stretched.
    const outerMargin = width >= 160 ? 1 : 0;
    const cardWidth = Math.max(12, width - outerMargin * 2);
    const innerWidth = Math.max(4, cardWidth - borderWidth - padLeft - padRight);
    // Reserve 2 columns for the `> ` prompt at the start of the editor body.
    const promptWidth = 2;
    const editorInnerWidth = Math.max(2, innerWidth - promptWidth);

    const rawEditorLines = super
      .render(editorInnerWidth)
      .map((line) => truncateToWidth(stripBgAnsi(line), editorInnerWidth));
    const editorLines = rawEditorLines.slice();
    // Drop pi-tui editor's built-in top/bottom horizontal border rows (and any
    // blank rows) so the composer panel frames the content directly.
    while (
      editorLines.length > 1 &&
      (isBlankRenderLine(editorLines[0]) || isEditorBorderLine(editorLines[0]))
    ) {
      editorLines.shift();
    }
    while (
      editorLines.length > 1 &&
      (isBlankRenderLine(editorLines[editorLines.length - 1]) ||
        isEditorBorderLine(editorLines[editorLines.length - 1]))
    ) {
      editorLines.pop();
    }
    const footer = this.footerRenderer
      ? this.footerRenderer(innerWidth, width)
      : { inside: [], outside: [] };

    const bar = theme ? theme.fg("accent", "┃") : "┃";
    const promptGlyph = theme ? theme.fg("accent", ">") : ">";
    const promptPrefix = `${promptGlyph} `;
    const continuationPrefix = "  ";
    const themeTokens = getFloatingComposerThemeTokens(theme);
    const panelBodyWidth = Math.max(0, cardWidth - borderWidth);
    const panelRow = (content: string) => {
      const padded = padPlain(content, panelBodyWidth);
      return bar + (theme ? applyBgAnsi(themeTokens.panelBg, padded) : padded);
    };
    const padBothSides = (content: string) =>
      " ".repeat(padLeft) + content + " ".repeat(Math.max(0, padRight));

    const lines: string[] = [];
    const leftMargin = " ".repeat(outerMargin);
    // blank panel row (same bar + bg fill, no content). Used for paddingY so
    // text isn't flush against the editor's top/bottom edges.
    const panelPad = () => leftMargin + panelRow("");

    // top paddingY
    lines.push(panelPad());

    editorLines.forEach((line, idx) => {
      const prefix = idx === 0 ? promptPrefix : continuationPrefix;
      const fitted = truncateToWidth(line, editorInnerWidth);
      const content = " ".repeat(padLeft) + prefix + fitted + " ".repeat(Math.max(0, padRight));
      lines.push(leftMargin + panelRow(content));
    });

    if (footer.inside.length > 0) {
      // gap between editor body and inline status rows
      lines.push(panelPad());
      for (const rawLine of footer.inside) {
        const wrapped = wrapTextWithAnsi(rawLine, innerWidth);
        for (const wline of wrapped) {
          lines.push(leftMargin + panelRow(padBothSides(truncateToWidth(wline, innerWidth))));
        }
      }
    }

    // bottom paddingY
    lines.push(panelPad());

    return lines.map((line) => truncateToWidth(line, width));
  }
}

export default function floatingComposerExtension(pi: ExtensionAPI) {
  let latestUsage: UsageSnapshot | null = null;
  let activeProvider: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let tuiRef: { requestRender: () => void } | null = null;
  let latestCtx: ExtensionContext | null = null;
  let latestResolution: FooterModelResolution | null = null;
  let footerThemeRef: any = null;
  let footerDataRef: any = null;
  let editorRef: FloatingComposerEditor | null = null;

  function refreshGitFooter(): void {
    if (refreshGitCache()) tuiRef?.requestRender();
  }

  function applyUsageProvider(model: Model<any> | undefined, options?: { force?: boolean }): void {
    const provider = detectProvider(model?.provider);
    if (!provider) {
      activeProvider = null;
      latestUsage = null;
      stopRefreshTimer();
      tuiRef?.requestRender();
      return;
    }

    const cached = usageCache.get(provider);
    if (cached && cached.windows.length > 0) {
      latestUsage = cached;
      tuiRef?.requestRender();
    }

    if (!options?.force && activeProvider === provider) {
      return;
    }

    activeProvider = provider;
    fetchUsageForProvider(provider)
      .then((usage) => {
        if (!usage || activeProvider !== provider) return;
        if (usage.windows.length === 0 && usage.error && cached?.windows.length) return;
        usageCache.set(provider, usage);
        latestUsage = usage;
        tuiRef?.requestRender();
      })
      .catch(() => {});
  }

  function startRefreshTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!activeProvider) return;
      const provider = activeProvider;
      const cached = usageCache.get(provider);
      fetchUsageForProvider(provider)
        .then((usage) => {
          if (!usage || activeProvider !== provider) return;
          if (usage.windows.length === 0 && usage.error && cached?.windows.length) return;
          usageCache.set(provider, usage);
          latestUsage = usage;
          tuiRef?.requestRender();
        })
        .catch(() => {});
    }, USAGE_REFRESH_INTERVAL);
  }

  function stopRefreshTimer(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function refreshResolution(ctx: ExtensionContext, logicalStatus?: string): void {
    latestCtx = ctx;
    latestResolution = resolveFooterModel(ctx, logicalStatus);
  }

  function refreshModelState(ctx: ExtensionContext, logicalStatus?: string, options?: { forceUsageRefresh?: boolean }): void {
    refreshResolution(ctx, logicalStatus);
    applyUsageProvider(latestResolution?.actualModel ?? ctx.model, { force: options?.forceUsageRefresh });
    startRefreshTimer();
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshGitCache();
    refreshModelState(ctx, undefined, { forceUsageRefresh: true });

    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => {
      tuiRef = tui;
      const editor = new FloatingComposerEditor(tui, theme, kb);
      editorRef = editor;
      footerThemeRef = ctx.ui.theme ?? theme;
      editor.setFooterRenderer((innerWidth: number, outerWidth: number) => {
        // Use the live theme ref so theme changes during a session are
        // picked up without remounting the editor. Falls back to the theme
        // captured at component construction.
        const footerTheme = footerThemeRef ?? ctx.ui.theme ?? theme;
        const footerData = footerDataRef;
        const safeCtx = latestCtx ?? ctx;
        const logicalStatus = sanitizeStatusText(footerData?.getExtensionStatuses?.().get("model-profiles"));
        refreshResolution(safeCtx, logicalStatus);

        const actualModel = latestResolution?.actualModel ?? safeCtx.model;
        const thinkingLevel = getThinkingLevel(safeCtx);
        const { percentage, used, total } = getContextInfo(safeCtx, actualModel ?? undefined);

        // pwd + branch (outside row, below the panel)
        let pwd = process.cwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        const normalizedPwd = pwd || ".";
        const lastSlash = normalizedPwd.lastIndexOf("/");
        const pwdParent = lastSlash >= 0 ? normalizedPwd.slice(0, lastSlash + 1) : "";
        const pwdBase = lastSlash >= 0 ? normalizedPwd.slice(lastSlash + 1) : normalizedPwd;

        let branchStr = "";
        if (gitCache?.branch) {
          const branchColor = gitCache.dirty ? "warning" : "success";
          branchStr = footerTheme.fg(branchColor, gitCache.branch);
          if (gitCache.dirty) branchStr += footerTheme.fg("warning", " *");
          if (gitCache.ahead) branchStr += footerTheme.fg("success", ` ↑${gitCache.ahead}`);
          if (gitCache.behind) branchStr += footerTheme.fg("error", ` ↓${gitCache.behind}`);
        }

        const sep = " " + footerTheme.fg("dim", "·") + " ";
        const pwdStr = `${footerTheme.fg("muted", pwdParent)}${footerTheme.fg("accent", pwdBase || normalizedPwd)}`;

        // INSIDE: single inline row. Left = profile status + provider/model
        // (+ thinking). Right = ctx gauge, width-aware.
        const statusBlocks: string[] = [];
        if (latestResolution?.logicalStatus) statusBlocks.push(footerTheme.fg("accent", latestResolution.logicalStatus));
        statusBlocks.push(formatModelSegment(actualModel, thinkingLevel, footerTheme));
        const statusLeft = statusBlocks.join(sep);

        // Row 1 (inside): profile/model on left, ctx on right
        const ctxBudget = Math.max(8, innerWidth - visibleWidth(statusLeft) - 2);
        const ctxVariants = [
          renderContextGauge(percentage, footerTheme, used, total, { includeCounts: true }),
          renderContextGauge(percentage, footerTheme, used, total, { includeCounts: false }),
        ];
        const statusRight = fitFooterSegment(ctxBudget, ctxVariants);
        const inside: string[] = [];
        inside.push(...joinFooterSides(statusLeft, statusRight, innerWidth));

        // Row 2 (inside): pwd + branch on left, provider usage on right when
        // available. Falls back to stacked rows on narrow widths.
        const pwdLine = fitFooterSegment(innerWidth, branchStr ? [pwdStr + sep + branchStr, pwdStr] : [pwdStr]);
        const showUsage = !!latestUsage && latestUsage.windows.length > 0 && innerWidth >= 58;
        if (showUsage) {
          const usage = latestUsage!;
          const usageLabel = footerTheme.fg("accent", usage.provider);
          const windowBudget = Math.max(12, innerWidth - visibleWidth(pwdLine) - visibleWidth(usageLabel) - 4);
          const windowVariants = (w: RateWindow) => [
            renderUsageWindow(w, footerTheme, { barWidth: 10, includeReset: true }),
            renderUsageWindow(w, footerTheme, { barWidth: 8, includeReset: true }),
            renderUsageWindow(w, footerTheme, { barWidth: 8, includeReset: false }),
            renderUsageWindow(w, footerTheme, { barWidth: 6, includeReset: false }),
            renderUsageWindow(w, footerTheme, { barWidth: 4, includeReset: false }),
          ];
          const usageRightRaw = [usageLabel, ...usage.windows.map((w) => fitFooterSegment(windowBudget, windowVariants(w)))].join(sep);
          inside.push(...joinFooterSides(pwdLine, usageRightRaw, innerWidth));
        } else {
          inside.push(truncateToWidth(pwdLine, innerWidth));
        }

        return { inside, outside: [] };
      }, footerThemeRef);
      return editor;
    });

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      tuiRef = tui;
      footerThemeRef = theme;
      footerDataRef = footerData;

      const unsub = footerData.onBranchChange(() => {
        refreshGitFooter();
      });

      const initialStatus = sanitizeStatusText(footerData.getExtensionStatuses().get("model-profiles"));
      refreshModelState(ctx, initialStatus, { forceUsageRefresh: true });
      editorRef?.setFooterRenderer(editorRef["footerRenderer"], theme);

      return {
        dispose: () => {
          unsub();
          tuiRef = null;
          stopRefreshTimer();
        },
        invalidate() {},
        render(_width: number): string[] {
          return [];
        },
      };
    });
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshGitFooter();
    refreshModelState(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshModelState(ctx, undefined, { forceUsageRefresh: true });
  });
}
