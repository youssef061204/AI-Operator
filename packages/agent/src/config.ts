import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentSettings } from "@operator-assist/shared";

const AGENT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(AGENT_PACKAGE_ROOT, "..", "..");

function applyEnvFile(filePath: string, externalEnvKeys: Set<string>): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/g);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (externalEnvKeys.has(key)) continue;

    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadRuntimeEnv(): void {
  const externalEnvKeys = new Set(Object.keys(process.env));
  const candidates = [
    path.join(REPO_ROOT, ".env"),
    path.join(REPO_ROOT, ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  const seen = new Set<string>();
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    applyEnvFile(resolved, externalEnvKeys);
  }
}

loadRuntimeEnv();

export const HOST = process.env.AGENT_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.AGENT_PORT ?? 7788);

export const DATA_DIR = path.resolve(process.env.AGENT_DATA_DIR ?? path.join(AGENT_PACKAGE_ROOT, "data"));
export const DB_PATH = path.join(DATA_DIR, "agent.db");
export const LOG_PATH = path.join(DATA_DIR, "audit.log");

export const DEFAULT_SETTINGS: AgentSettings = {
  approval_mode: false,
  desktop_popups: true,
  browser_automation_mode: "browser",
  workspace_root: path.resolve(process.env.AGENT_WORKSPACE_ROOT ?? path.join(REPO_ROOT, "generated", "operator-assist")),
  provider: "vercel",
  telemetry_enabled: false,
  per_action_timeout_ms: 240000,
  always_allow_permissions: [],
  dry_run_mode: false,
  control_mode: "operator",
  voice_mode: false,
  focus_mode: true,
  memory_notes: "",
  autonomous_runtime: true,
  intent_stream_compact: true,
  irreversible_action_guard: "high",
};
