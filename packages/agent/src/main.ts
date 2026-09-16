import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntimeServer } from "./runtime/server.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const workspace = path.resolve(process.env.OPERATOR_WORKSPACE ?? repoRoot);
const dataDir = path.resolve(
  process.env.OPERATOR_DATA_DIR ?? path.join(repoRoot, ".operator"),
);
const bootstrapCode = process.env.OPERATOR_BOOTSTRAP_CODE;
delete process.env.OPERATOR_BOOTSTRAP_CODE;
const server = await startRuntimeServer({
  workspace,
  dataDir,
  port: Number(process.env.OPERATOR_PORT ?? 7788),
  token: process.env.OPERATOR_API_TOKEN,
  bootstrapCode,
  evaluationDir: path.join(repoRoot, "artifacts", "evaluation"),
});
console.log(
  `AI Operator listening on http://127.0.0.1:${server.port}\nWorkspace: ${workspace}\nAPI token file: ${server.tokenPath}\nModel: ${process.env.GEMINI_MODEL ?? "gemini-3.8-flash"}.`,
);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void server.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
