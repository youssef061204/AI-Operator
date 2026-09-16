import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startRuntimeServer } from "../src/runtime/server.js";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operator-browser-"));
const workspace = path.join(directory, "workspace");
await fs.mkdir(workspace);
const server = await startRuntimeServer({
  workspace,
  dataDir: path.join(directory, "data"),
  port: 7788,
  token: "browser-fixture-token-".repeat(3),
  isolate: false,
  origins: ["http://localhost:3010"],
  providers: [
    {
      name: "browser-test fixture (not a live model)",
      async decide(context, signal) {
        signal.throwIfAborted();
        if (context.objective.includes("Cancel"))
          return {
            decision: {
              kind: "act",
              reason: "Wait in a local command for cancellation",
              plan: ["Wait"],
              call: {
                tool: "shell",
                command: process.execPath,
                args: ["-e", "setInterval(()=>{},1000)"],
                cwd: ".",
                timeoutMs: 30000,
              },
            },
          };
        if (context.observations.length)
          return {
            decision: { kind: "finish", summary: "Verified fixture result" },
          };
        return {
          decision: {
            kind: "act",
            reason: "Create the requested fixture file",
            plan: ["Create file", "Verify contents"],
            call: {
              tool: "write_file",
              path: context.objective.includes("Deny")
                ? "denied.txt"
                : "result.txt",
              content: "ok",
              expectedHash: null,
            },
          },
        };
      },
    },
  ],
});
console.log(`Browser fixture listening on ${server.port}`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void server
    .close()
    .then(() => fs.rm(directory, { recursive: true, force: true }))
    .then(() => process.exit(0));
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
