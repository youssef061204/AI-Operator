import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Task, TaskEvent } from "./contracts.js";
import { terminal, PersistedTaskSchema } from "./contracts.js";

// Redact known environment secrets and credential-shaped fields before durable storage.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(password|secret|api_?key|authorization|access_token)$/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  if (typeof value !== "string") return value;
  let text = value.replace(
    /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|Bearer\s+[\w.-]{12,})/gi,
    "[REDACTED]",
  );
  for (const [key, secret] of Object.entries(process.env))
    if (/key|token|secret|password/i.test(key) && secret && secret.length >= 8)
      text = text.split(secret).join("[REDACTED]");
  return text;
}

export class TaskStore {
  private db!: DatabaseSync;
  private readonly lockPath: string;
  private closed = false;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.lockPath = path.join(directory, "runtime.lock");
    try {
      fs.writeFileSync(
        this.lockPath,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      throw new Error(
        `Runtime data directory is locked: ${this.lockPath}. If its recorded process is no longer running, remove this stale lock before restarting.`,
      );
    }
    try {
      this.db = new DatabaseSync(path.join(directory, "runtime.db"));
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);",
      );
      for (const task of this.list())
        if (!terminal(task.status)) {
          task.status = "interrupted";
          task.error =
            "Runtime restarted; side effects are not automatically replayed.";
          delete task.approval;
          this.save(task, "interrupted", { reason: task.error });
        }
    } catch (error) {
      this.db?.close();
      fs.unlinkSync(this.lockPath);
      throw error;
    }
  }
  list(): Task[] {
    return (
      this.db
        .prepare("SELECT body FROM tasks ORDER BY rowid DESC LIMIT 200")
        .all() as { body: string }[]
    ).map((row) => {
      try {
        return PersistedTaskSchema.parse(JSON.parse(row.body));
      } catch {
        throw new Error(
          "Corrupt task state; preserve runtime.db and recover from backup.",
        );
      }
    });
  }
  save(
    task: Task,
    type: string,
    data: Record<string, unknown> = {},
  ): TaskEvent {
    const at = Date.now();
    task.updatedAt = at;
    const cleanData = redact(data) as Record<string, unknown>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO tasks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(task.id, JSON.stringify(redact(task)));
      const result = this.db
        .prepare("INSERT INTO events(task_id,type,at,data) VALUES(?,?,?,?)")
        .run(task.id, type, at, JSON.stringify(cleanData));
      this.db.exec("COMMIT");
      return {
        seq: Number(result.lastInsertRowid),
        taskId: task.id,
        type,
        at,
        data: cleanData,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  events(id: string, after = 0): TaskEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 1000",
        )
        .all(id, after) as {
        seq: number;
        task_id: string;
        type: string;
        at: number;
        data: string;
      }[]
    ).map((row) => ({
      seq: row.seq,
      taskId: row.task_id,
      type: row.type,
      at: row.at,
      data: JSON.parse(row.data),
    }));
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    fs.unlinkSync(this.lockPath);
    this.closed = true;
  }
}
