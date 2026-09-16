import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export interface ChangeFile {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  before: string | null;
  after: string | null;
}
export interface ChangeSet {
  taskId: string;
  digest: string;
  status:
    | "proposed"
    | "accepted"
    | "discarded"
    | "reverted"
    | "recovery_required";
  files: ChangeFile[];
  baseHead: string;
}
export interface PreparedWorkspace {
  taskId: string;
  workspace: string;
  baseHead: string;
  kind: "git-worktree";
}
interface RecordState extends PreparedWorkspace {
  source: string;
  baseline: Record<string, string>;
  changeset?: ChangeSet;
  transaction?: {
    direction: "accept" | "revert";
    state: "prepared" | "committed";
    attempted: string[];
  };
}
const MAX_FILES = 2000;
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const fingerprint = (text: string | null): string | null =>
  text === null ? null : sha(text);
const excluded = (name: string): boolean =>
  /^(?:\.git|\.operator|\.ssh|node_modules|dist|coverage|\.next|\.venv|__pycache__)$/iu.test(
    name,
  ) || /^\.env/iu.test(name);
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Git provides task isolation; the journal provides recoverable, conflict-aware batches.
 * Neither promises simultaneous multi-file visibility or safety from hostile host writers. */
export class TaskWorkspaceBroker {
  private readonly source: string;
  private readonly data: string;
  constructor(sourceRoot: string, dataRoot: string) {
    this.source = path.resolve(sourceRoot);
    this.data = path.resolve(dataRoot);
    if (this.source === this.data)
      throw new Error("Workspace data must be separate from repository root");
  }
  private taskDirectory(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,128}$/u.test(id)) throw new Error("Invalid task id");
    return path.join(this.data, "task-workspaces", id);
  }
  private async safe(target: string): Promise<void> {
    const resolved = path.resolve(target);
    let current = path.parse(resolved).root;
    for (const part of path
      .relative(current, resolved)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new Error("Workspace symlinks and junctions are forbidden");
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  private target(root: string, input: string): string {
    const parts = input.split("/");
    if (
      !input ||
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          excluded(p) ||
          /[\\<>:"|?*\u0000-\u001f]/u.test(p) ||
          /[. ]$/u.test(p) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p),
      )
    )
      throw new Error(`Unsupported workspace path: ${input}`);
    return path.join(root, ...parts);
  }
  private async text(target: string): Promise<string | null> {
    await this.safe(target);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE)
        throw new Error("Only bounded regular files are supported");
      const bytes = await fs.readFile(target);
      if (bytes.length > MAX_FILE)
        throw new Error("File exceeds workspace limit");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0"))
        throw new Error("Binary files are unsupported in task snapshots");
      return text;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async durable(target: string, text: string): Promise<void> {
    await this.safe(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.safe(path.dirname(target));
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, target);
      // Windows does not expose directory fsync through Node.
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(target), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }
  private async git(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
    ])
      if (process.env[key]) env[key] = process.env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    const hooks = path.join(this.data, "empty-hooks");
    await this.safe(hooks);
    await fs.mkdir(hooks, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "maintenance.auto=false",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        { cwd: this.source, env, shell: false, windowsHide: true },
      );
      let output = "",
        error = "",
        overflow = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Git workspace operation timed out"));
      }, 30000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > MAX_TOTAL) {
          overflow = true;
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (error.length < 4000) error += chunk.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || overflow)
          reject(
            new Error(
              `Git workspace operation failed: ${error.slice(0, 4000)}`,
            ),
          );
        else resolve(output);
      });
    });
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.safe(this.source);
    await this.safe(this.data);
    let common: string;
    try {
      common = path.resolve(
        this.source,
        (await this.git(["rev-parse", "--git-common-dir"])).trim(),
      );
    } catch {
      throw new Error(
        "Task isolation requires an initialized Git repository with a commit",
      );
    }
    await this.safe(common);
    const lock = path.join(common, "ai-operator-workspace.lock");
    const handle = await fs.open(lock, "wx", 0o600).catch(() => {
      throw new Error(
        "Repository workspace is locked; inspect any stale lock before recovery",
      );
    });
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: Date.now() }),
      );
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
  private async save(record: RecordState): Promise<void> {
    await this.durable(
      path.join(this.taskDirectory(record.taskId), "journal.json"),
      JSON.stringify(record),
    );
  }
  private async load(id: string): Promise<RecordState> {
    const filename = path.join(this.taskDirectory(id), "journal.json");
    await this.safe(filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TOTAL * 5)
      throw new Error("Invalid workspace journal");
    const record = JSON.parse(
      await fs.readFile(filename, "utf8"),
    ) as RecordState;
    if (
      record.taskId !== id ||
      record.source !== this.source ||
      record.workspace !== path.join(this.taskDirectory(id), "tree") ||
      typeof record.baseline !== "object"
    )
      throw new Error("Workspace journal binding mismatch");
    return record;
  }
  async prepare(taskId: string): Promise<PreparedWorkspace> {
    return this.locked(async () => {
      const directory = this.taskDirectory(taskId);
      await this.safe(directory);
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await fs.mkdir(directory, { recursive: false });
      const top = path.resolve(
        (await this.git(["rev-parse", "--show-toplevel"])).trim(),
      );
      if (top.toLowerCase() !== this.source.toLowerCase())
        throw new Error("Select the Git repository root for task isolation");
      const baseHead = (
        await this.git(["rev-parse", "--verify", "HEAD"])
      ).trim();
      const paths = (
        await this.git([
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean);
      const baseline: Record<string, string> = Object.create(null);
      const seen = new Set<string>();
      let total = 0;
      for (const name of [...new Set(paths)].sort()) {
        if (name.split("/").some(excluded)) continue;
        if (seen.has(name.toLowerCase()))
          throw new Error("Case-colliding paths are unsupported");
        seen.add(name.toLowerCase());
        if (seen.size > MAX_FILES)
          throw new Error("Workspace exceeds file count limit");
        const content = await this.text(this.target(this.source, name));
        if (content === null) continue;
        total += Buffer.byteLength(content);
        if (total > MAX_TOTAL)
          throw new Error("Workspace exceeds snapshot byte limit");
        baseline[name] = content;
      }
      const workspace = path.join(directory, "tree");
      await this.git([
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        workspace,
        baseHead,
      ]);
      const record: RecordState = {
        taskId,
        workspace,
        baseHead,
        kind: "git-worktree",
        source: this.source,
        baseline,
      };
      try {
        for (const [name, content] of Object.entries(baseline))
          await this.durable(this.target(workspace, name), content);
        await this.save(record);
      } catch (error) {
        await this.git(["worktree", "remove", "--force", workspace]).catch(
          () => undefined,
        );
        throw error;
      }
      return { taskId, workspace, baseHead, kind: "git-worktree" };
    });
  }
  private async scan(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = Object.create(null);
    let total = 0,
      entries = 0;
    const visit = async (relative: string): Promise<void> => {
      const directory = relative ? this.target(root, relative) : root;
      await this.safe(directory);
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (excluded(item.name)) continue;
        if (++entries > MAX_FILES)
          throw new Error("Task workspace exceeds entry limit");
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) await visit(name);
        else {
          const text = await this.text(this.target(root, name));
          if (text === null)
            throw new Error("Task workspace changed during snapshot");
          total += Buffer.byteLength(text);
          if (total > MAX_TOTAL)
            throw new Error("Task workspace exceeds byte limit");
          files[name] = text;
        }
      }
    };
    await visit("");
    return files;
  }
  async changes(taskId: string): Promise<ChangeSet> {
    return this.locked(async () => {
      const record = await this.load(taskId);
      await this.recover(record);
      if (record.changeset) return record.changeset;
      const after = await this.scan(record.workspace);
      const names = [
        ...new Set([...Object.keys(record.baseline), ...Object.keys(after)]),
      ].sort();
      const lower = new Set<string>();
      const files: ChangeFile[] = [];
      for (const name of names) {
        if (lower.has(name.toLowerCase()))
          throw new Error("Case-colliding paths are unsupported");
        lower.add(name.toLowerCase());
        const before = record.baseline[name] ?? null,
          next = after[name] ?? null;
        if (before !== next)
          files.push({
            path: name,
            before,
            after: next,
            beforeHash: fingerprint(before),
            afterHash: fingerprint(next),
          });
      }
      const digest = sha(
        JSON.stringify({ taskId, baseHead: record.baseHead, files }),
      );
      record.changeset = {
        taskId,
        baseHead: record.baseHead,
        digest,
        status: "proposed",
        files,
      };
      await this.save(record);
      return record.changeset;
    });
  }
  private validate(record: RecordState, digest: string): ChangeSet {
    const set = record.changeset;
    if (
      !set ||
      set.digest !== digest ||
      sha(
        JSON.stringify({
          taskId: set.taskId,
          baseHead: set.baseHead,
          files: set.files,
        }),
      ) !== digest
    )
      throw new Error("Changeset changed or review digest is stale");
    return set;
  }
  private async write(name: string, text: string | null): Promise<void> {
    const target = this.target(this.source, name);
    await this.safe(target);
    if (text === null) {
      await fs.unlink(target);
      if (process.platform !== "win32") {
        const dir = await fs.open(path.dirname(target), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } else await this.durable(target, text);
  }
  private async recover(record: RecordState): Promise<void> {
    if (record.transaction?.state !== "prepared") return;
    const set = this.validate(record, record.changeset!.digest);
    const reverse = record.transaction.direction === "revert";
    let conflict = false;
    for (const file of [...set.files].reverse()) {
      if (!record.transaction.attempted.includes(file.path)) continue;
      const before = reverse ? file.after : file.before,
        after = reverse ? file.before : file.after;
      const current = await this.text(this.target(this.source, file.path));
      if (current === before) continue;
      if (current !== after) {
        conflict = true;
        continue;
      }
      await this.write(file.path, before);
    }
    set.status = conflict
      ? "recovery_required"
      : reverse
        ? "accepted"
        : "proposed";
    if (!conflict) delete record.transaction;
    await this.save(record);
  }
  private async apply(
    id: string,
    digest: string,
    reverse: boolean,
  ): Promise<ChangeSet> {
    return this.locked(async () => {
      const record = await this.load(id);
      await this.recover(record);
      const set = this.validate(record, digest);
      if (set.status !== (reverse ? "accepted" : "proposed"))
        throw new Error(`Cannot apply changeset in ${set.status} state`);
      for (const file of set.files) {
        const current = await this.text(this.target(this.source, file.path));
        if (current !== (reverse ? file.after : file.before))
          throw new Error(`External edit conflict: ${file.path}`);
      }
      record.transaction = {
        direction: reverse ? "revert" : "accept",
        state: "prepared",
        attempted: [],
      };
      await this.save(record);
      try {
        for (const file of set.files) {
          const current = await this.text(this.target(this.source, file.path));
          if (current !== (reverse ? file.after : file.before))
            throw new Error(`External edit conflict: ${file.path}`);
          record.transaction.attempted.push(file.path);
          await this.save(record);
          await this.write(file.path, reverse ? file.before : file.after);
        }
        record.transaction.state = "committed";
        set.status = reverse ? "reverted" : "accepted";
        await this.save(record);
      } catch (error) {
        record.transaction.state = "prepared";
        await this.recover(record);
        throw error;
      }
      return set;
    });
  }
  accept(taskId: string, digest: string): Promise<ChangeSet> {
    return this.apply(taskId, digest, false);
  }
  revert(taskId: string, digest: string): Promise<ChangeSet> {
    return this.apply(taskId, digest, true);
  }
  async discard(taskId: string, digest: string): Promise<ChangeSet> {
    return this.locked(async () => {
      const record = await this.load(taskId);
      await this.recover(record);
      const set = this.validate(record, digest);
      if (set.status !== "proposed")
        throw new Error(`Cannot discard changeset in ${set.status} state`);
      await this.safe(record.workspace);
      await this.git(["worktree", "remove", "--force", record.workspace]);
      set.status = "discarded";
      await this.save(record);
      return set;
    });
  }
}
