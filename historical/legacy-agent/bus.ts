import fs from "node:fs";
import path from "node:path";

import { WebSocket } from "ws";

import { LOG_PATH } from "./config.js";
import { type Storage } from "./storage.js";
import { newId, nowIso } from "./utils.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export class LogBus {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly storage: Storage) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
  }

  emitLog(level: LogLevel, eventType: string, message: string, data?: Record<string, unknown>, actionId?: string): void {
    const entry = {
      id: newId(),
      timestamp: nowIso(),
      level,
      event_type: eventType,
      action_id: actionId,
      message,
      data: data ?? {},
    };

    this.storage.appendLog({
      id: entry.id,
      action_id: actionId,
      level,
      event_type: eventType,
      message,
      data: data ?? {},
      created_at: entry.timestamp,
    });

    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    this.broadcast({ type: "log", data: entry });
  }

  emitQueueSnapshot(snapshot: Record<string, unknown>): void {
    this.broadcast({ type: "queue_snapshot", data: snapshot });
  }

  broadcast(payload: Record<string, unknown>): void {
    const encoded = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
    }
  }
}
