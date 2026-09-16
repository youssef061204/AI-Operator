import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      process.env[key] !== undefined
    )
      continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    process.env[key] = value;
  }
}
loadDotEnv(path.join(root, ".env"));
loadDotEnv(path.join(root, ".env.local"));
if (
  Number(process.versions.node.split(".")[0]) !== 24 ||
  Number(process.versions.node.split(".")[1]) < 13
)
  fail(
    "AI Operator requires Node 24.13 or newer within Node 24. Install Node 24 LTS, then run pnpm dev again.",
  );
const workspace = path.resolve(process.env.OPERATOR_WORKSPACE ?? root);
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory())
  fail(`Workspace does not exist: ${workspace}`);
const pnpm = process.env.npm_execpath;
if (!pnpm)
  fail("Start using pnpm dev so the installed pnpm executable can be located.");
const port = Number(process.env.OPERATOR_PORT ?? 7788);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  fail("OPERATOR_PORT must be an integer from 1 to 65535.");
async function isAvailable(checkPort) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(checkPort, "127.0.0.1", () =>
      server.close(() => resolve(true)),
    );
  });
}
let webPort = Number(process.env.OPERATOR_WEB_PORT ?? 3000);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  fail("OPERATOR_WEB_PORT must be an integer from 1 to 65535.");
if (!(await isAvailable(webPort))) {
  const requestedWebPort = webPort;
  while (webPort <= 65535 && !(await isAvailable(webPort))) webPort += 1;
  if (webPort > 65535) fail("No available web port was found.");
  console.warn(
    `Web port ${requestedWebPort} is occupied; using available port ${webPort}. No existing process was stopped.`,
  );
}
if (webPort === port) {
  fail(
    `Web port ${webPort} conflicts with OPERATOR_PORT. Set OPERATOR_WEB_PORT to a different port.`,
  );
}
const backend = process.env.OPERATOR_EXECUTION_BACKEND ?? "docker";
if (!["docker", "native"].includes(backend))
  fail("OPERATOR_EXECUTION_BACKEND must be docker or native.");
if (backend === "docker") {
  const image =
    process.env.OPERATOR_DOCKER_IMAGE ?? "node:24.13.0-bookworm-slim";
  const check = spawnSync("docker", ["image", "inspect", image], {
    timeout: 5000,
    stdio: "ignore",
    windowsHide: true,
  });
  if (check.status !== 0)
    console.warn(
      `Docker execution is not ready. Start Docker and run: docker pull ${image}. The console can open, but commands will fail until Docker is ready.`,
    );
} else
  console.warn(
    "Native execution selected: approved commands run with your operating-system privileges.",
  );
if (!process.env.GEMINI_API_KEY)
  fail(
    "GEMINI_API_KEY is missing. Add it to .env or your process environment; the key is never committed.",
  );
process.env.GEMINI_MODEL ??= "gemini-3.8-flash";
const bootstrap = randomBytes(32).toString("hex");
const children = [];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (process.platform === "win32" && child.pid)
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  process.exit(code);
}
const start = (args, env) => {
  const child = spawn(process.execPath, [pnpm, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!closing) stop(code ?? 1);
  });
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
start(["--filter", "@operator-assist/agent", "dev"], {
  OPERATOR_BOOTSTRAP_CODE: bootstrap,
});
start(
  [
    "--filter",
    "@operator-assist/web",
    "exec",
    "next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "-p",
    String(webPort),
  ],
  { NEXT_PUBLIC_AGENT_URL: `http://127.0.0.1:${port}` },
);
const url = `http://127.0.0.1:${webPort}/#connect=${bootstrap}`;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const [api, web] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      }),
      fetch(`http://127.0.0.1:${webPort}`, {
        signal: AbortSignal.timeout(1000),
      }),
    ]);
    if (api.ok && web.ok) {
      console.log(
        `\nOpen AI Operator (private, one-use connection link; expires in 5 minutes):\n${url}\n`,
      );
      if (process.env.OPERATOR_OPEN_BROWSER !== "0") {
        const opener =
          process.platform === "win32"
            ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
                stdio: "ignore",
                windowsHide: true,
              })
            : spawn(
                process.platform === "darwin" ? "open" : "xdg-open",
                [url],
                { stdio: "ignore" },
              );
        opener.on("error", () =>
          console.log("Open the connection link above in your browser."),
        );
        opener.unref();
      }
      break;
    }
  } catch {
    /* Startup in progress. */
  }
  if (attempt === 119) {
    console.error("Startup timed out. Check the service output above.");
    stop(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
