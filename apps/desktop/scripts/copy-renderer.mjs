import fs from "node:fs";
import path from "node:path";

const srcDir = path.resolve("src", "renderer");
const outDir = path.resolve("dist", "renderer");
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}
