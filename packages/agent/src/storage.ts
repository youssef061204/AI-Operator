import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ActionEnvelope, ActionState, AgentSettings } from "@operator-assist/shared";
import { AgentSettingsSchema, BrowserAutomationModeSchema, DeployProviderSchema } from "@operator-assist/shared";

import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS } from "./config.js";
import { nowIso, newId, safeJsonParse } from "./utils.js";

type PersistedAction = ActionEnvelope & {
  stdout?: string;
  stderr?: string;
  screenshot_path?: string;
};

export class Storage {
  private readonly db: DatabaseSync;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        required_permissions_json TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        stdout TEXT,
        stderr TEXT,
        screenshot_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        action_id TEXT,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        pairing_code TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);

    const existing = this.db.prepare("SELECT value FROM settings WHERE key = ?").get("agent_settings") as { value: string } | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_settings", JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  listActions(): PersistedAction[] {
    const rows = this.db.prepare("SELECT * FROM actions ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      run_id: String(row.run_id),
      project_id: row.project_id ? String(row.project_id) : undefined,
      type: String(row.type) as ActionEnvelope["type"],
      description: String(row.description),
      risk_level: String(row.risk_level) as ActionEnvelope["risk_level"],
      required_permissions: safeJsonParse<string[]>(String(row.required_permissions_json ?? "[]"), []),
      inputs: safeJsonParse<Record<string, unknown>>(String(row.inputs_json ?? "{}"), {}),
      state: String(row.state) as ActionState,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      result: safeJsonParse<Record<string, unknown> | undefined>(row.result_json ? String(row.result_json) : undefined, undefined),
      error: row.error ? String(row.error) : undefined,
      stdout: row.stdout ? String(row.stdout) : undefined,
      stderr: row.stderr ? String(row.stderr) : undefined,
      screenshot_path: row.screenshot_path ? String(row.screenshot_path) : undefined,
    }));
  }

  getSettingValue(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSettingValue(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  getJsonSetting<T>(key: string, fallback: T): T {
    return safeJsonParse<T>(this.getSettingValue(key), fallback);
  }

  setJsonSetting<T>(key: string, value: T): void {
    this.setSettingValue(key, JSON.stringify(value));
  }

  upsertAction(action: PersistedAction): void {
    this.db
      .prepare(`
        INSERT INTO actions (
          id, run_id, project_id, type, description, risk_level, required_permissions_json,
          inputs_json, state, result_json, error, stdout, stderr, screenshot_path, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          run_id=excluded.run_id,
          project_id=excluded.project_id,
          type=excluded.type,
          description=excluded.description,
          risk_level=excluded.risk_level,
          required_permissions_json=excluded.required_permissions_json,
          inputs_json=excluded.inputs_json,
          state=excluded.state,
          result_json=excluded.result_json,
          error=excluded.error,
          stdout=excluded.stdout,
          stderr=excluded.stderr,
          screenshot_path=excluded.screenshot_path,
          updated_at=excluded.updated_at
      `)
      .run(
        action.id,
        action.run_id,
        action.project_id ?? null,
        action.type,
        action.description,
        action.risk_level,
        JSON.stringify(action.required_permissions ?? []),
        JSON.stringify(action.inputs ?? {}),
        action.state,
        action.result ? JSON.stringify(action.result) : null,
        action.error ?? null,
        action.stdout ?? null,
        action.stderr ?? null,
        action.screenshot_path ?? null,
        action.created_at,
        action.updated_at ?? nowIso(),
      );
  }

  appendLog(entry: {
    id: string;
    action_id?: string;
    level: "debug" | "info" | "warn" | "error";
    event_type: string;
    message: string;
    data?: Record<string, unknown>;
    created_at: string;
  }): void {
    this.db
      .prepare("INSERT INTO logs (id, action_id, level, event_type, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.action_id ?? null, entry.level, entry.event_type, entry.message, JSON.stringify(entry.data ?? {}), entry.created_at);
  }

  getSettings(): AgentSettings {
    const parsed = this.getJsonSetting<AgentSettings>("agent_settings", DEFAULT_SETTINGS);
    const merged: AgentSettings = { ...DEFAULT_SETTINGS, ...parsed };
    merged.browser_automation_mode = BrowserAutomationModeSchema.parse(merged.browser_automation_mode);
    merged.provider = DeployProviderSchema.parse(merged.provider);
    return AgentSettingsSchema.parse(merged);
  }

  updateSettings(patch: Partial<AgentSettings>): AgentSettings {
    const next = AgentSettingsSchema.parse({ ...this.getSettings(), ...patch });
    this.setJsonSetting("agent_settings", next);
    return next;
  }

  getDefaultPairingCode(): string {
    const key = "default_pairing_code";
    const existing = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    const value = String(existing?.value ?? "").trim().toUpperCase();
    if (value.length >= 4) return value;

    const generated = `AUTO-${newId().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, generated);
    return generated;
  }

  registerDevice(
    pairingCode: string,
    deviceName: string,
    deviceId: string,
  ): { pairing_code: string; device_id: string; device_name: string; registered_at: string; last_seen: string } {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO devices (pairing_code, device_id, device_name, registered_at, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pairing_code) DO UPDATE SET
           device_id = excluded.device_id,
           device_name = excluded.device_name,
           last_seen = excluded.last_seen`,
      )
      .run(pairingCode, deviceId, deviceName, now, now);

    const row = this.db
      .prepare("SELECT pairing_code, device_id, device_name, registered_at, last_seen FROM devices WHERE pairing_code = ?")
      .get(pairingCode) as { pairing_code: string; device_id: string; device_name: string; registered_at: string; last_seen: string };
    return row;
  }

  getDeviceStatus(pairingCode: string): { connected: boolean; device?: Record<string, string> } {
    const row = this.db
      .prepare("SELECT pairing_code, device_id, device_name, registered_at, last_seen FROM devices WHERE pairing_code = ?")
      .get(pairingCode) as Record<string, string> | undefined;
    if (!row) return { connected: false };
    return { connected: true, device: row };
  }
}

export type { PersistedAction };
