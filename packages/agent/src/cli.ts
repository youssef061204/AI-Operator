import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [command = "help", id, arg] = process.argv.slice(2);
if (command === "help" || command === "--help") {
  console.log(
    "AI Operator CLI\n  tasks\n  create request.json\n  show TASK_ID\n  events TASK_ID\n  approve TASK_ID APPROVAL_JSON_FILE\n  pause|resume|cancel TASK_ID\n  restore TASK_ID CHECKPOINT_ID\nEnvironment: OPERATOR_PORT, OPERATOR_DATA_DIR, OPERATOR_API_TOKEN. Server must be running.",
  );
} else {
  try {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const token =
      process.env.OPERATOR_API_TOKEN ??
      fs
        .readFileSync(
          path.join(
            process.env.OPERATOR_DATA_DIR ?? path.join(root, ".operator"),
            "api-token",
          ),
          "utf8",
        )
        .trim();
    let endpoint = "/tasks";
    let method = "GET";
    let body: unknown;
    if (command === "create") {
      body = JSON.parse(fs.readFileSync(id, "utf8"));
      method = "POST";
    } else if (command === "show")
      endpoint = `/tasks/${encodeURIComponent(id)}`;
    else if (command === "events")
      endpoint = `/tasks/${encodeURIComponent(id)}/events`;
    else if (
      ["approve", "pause", "resume", "cancel", "restore"].includes(command)
    ) {
      endpoint = `/tasks/${encodeURIComponent(id)}/${command}`;
      method = "POST";
      body =
        command === "approve"
          ? JSON.parse(fs.readFileSync(arg, "utf8"))
          : command === "restore"
            ? { checkpointId: arg }
            : {};
    } else if (command !== "tasks")
      throw new Error("Unknown command; use --help");
    const response = await fetch(
      `http://127.0.0.1:${process.env.OPERATOR_PORT ?? 7788}${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
