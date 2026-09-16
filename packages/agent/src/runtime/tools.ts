import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { lstatSync } from "node:fs";
import {
  basename,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { NativeExecutionBackend, type ExecutionBackend } from "./execution.js";
import { z } from "zod";

const MAX_READ_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_BYTES = MAX_TEXT_BYTES + 16 * 1024;
const MAX_SHELL_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 1_000;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_DIRECTORIES = 1_000;
const MAX_SEARCH_MATCHES = 500;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 1_024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 8_192;

const PathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const HashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a SHA-256 hex hash");

export const ToolCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("read_file"), path: PathSchema }).strict(),
  z
    .object({ tool: z.literal("list_files"), path: PathSchema.default(".") })
    .strict(),
  z
    .object({
      tool: z.literal("search"),
      query: z.string().min(1).max(MAX_ARGUMENT_LENGTH),
      path: PathSchema.default("."),
    })
    .strict(),
  z
    .object({
      tool: z.literal("write_file"),
      path: PathSchema,
      content: z.string().max(MAX_TEXT_BYTES),
      expectedHash: HashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("patch_file"),
      path: PathSchema,
      oldText: z.string().min(1).max(MAX_TEXT_BYTES),
      newText: z.string().max(MAX_TEXT_BYTES),
      expectedHash: HashSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("shell"),
      command: z.string().min(1).max(MAX_ARGUMENT_LENGTH),
      args: z.array(z.string().max(MAX_ARGUMENT_LENGTH)).max(MAX_ARGUMENTS),
      cwd: PathSchema.default("."),
      timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    })
    .strict(),
  z
    .object({
      tool: z.literal("restore"),
      checkpointId: z.string().min(1).max(128),
    })
    .strict(),
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;

export function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

type Checkpoint = {
  version: 1;
  workspace: string;
  path: string;
  beforeContent: string | null;
  beforeHash: string | null;
  afterHash: string;
};

const sensitiveComponent = (component: string): boolean => {
  const lower = component.toLowerCase();
  return (
    lower === ".git" ||
    lower === "node_modules" ||
    lower === ".ssh" ||
    lower === ".operator" ||
    lower.startsWith(".env")
  );
};

const isWindowsReserved = (component: string): boolean => {
  const cleaned = component.replace(/[. ]+$/u, "").toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/u.test(cleaned);
};

const appendBounded = (
  state: { chunks: Buffer[]; length: number; truncated: boolean },
  chunk: Buffer,
): void => {
  const remaining = MAX_SHELL_BYTES - state.length;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.length > remaining) {
    state.chunks.push(chunk.subarray(0, remaining));
    state.length += remaining;
    state.truncated = true;
    return;
  }
  state.chunks.push(chunk);
  state.length += chunk.length;
};

const truncateUtf8 = (content: string, maxBytes: number): string => {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let low = 0;
  let high = Math.min(content.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), "utf8") <= maxBytes)
      low = middle;
    else high = middle - 1;
  }
  return content.slice(0, low);
};

export class WorkspaceTools {
  private readonly workspace: string;
  private readonly checkpointDir: string;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    workspace: string,
    checkpointDir: string,
    private readonly execution: ExecutionBackend = new NativeExecutionBackend(),
  ) {
    this.workspace = resolve(workspace);
    this.checkpointDir = resolve(checkpointDir);
    this.assertSafeAbsoluteAncestors(this.workspace);
    this.assertSafeAbsoluteAncestors(this.checkpointDir);
  }

  public describe(call: ToolCall): {
    risk: "LOW" | "MEDIUM" | "HIGH";
    resources: string[];
    reversible: boolean;
  } {
    const parsed = ToolCallSchema.parse(call);
    switch (parsed.tool) {
      case "read_file":
      case "list_files":
      case "search":
        return {
          risk: "LOW",
          resources: [this.displayPath(parsed.path)],
          reversible: true,
        };
      case "write_file":
      case "patch_file":
        return {
          risk: "MEDIUM",
          resources: [this.displayPath(parsed.path)],
          reversible: true,
        };
      case "restore":
        return {
          risk: "HIGH",
          resources: [`checkpoint:${parsed.checkpointId}`],
          reversible: false,
        };
      case "shell":
        return {
          risk: "HIGH",
          resources: [
            `command:${parsed.command}`,
            ...parsed.args.map((arg, index) => `arg[${index}]:${arg}`),
            `cwd:${this.displayPath(parsed.cwd)}`,
          ],
          reversible: false,
        };
    }
  }

  public async execute(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.throwIfAborted(signal);
    const parsed = ToolCallSchema.parse(call);
    switch (parsed.tool) {
      case "read_file":
        return this.readFile(parsed.path);
      case "list_files":
        return this.listFiles(parsed.path);
      case "search":
        return this.search(parsed.query, parsed.path);
      case "write_file":
        return this.serialized(() =>
          this.writeFile(
            parsed.path,
            parsed.content,
            parsed.expectedHash,
            signal,
          ),
        );
      case "patch_file":
        return this.serialized(() =>
          this.patchFile(
            parsed.path,
            parsed.oldText,
            parsed.newText,
            parsed.expectedHash,
            signal,
          ),
        );
      case "restore":
        return this.serialized(() => this.restore(parsed.checkpointId, signal));
      case "shell":
        return this.runShell(
          parsed.command,
          parsed.args,
          parsed.cwd,
          parsed.timeoutMs,
          signal,
        );
    }
  }

  private async readFile(input: string): Promise<Record<string, unknown>> {
    const target = this.resolvePath(input);
    const stat = await fs.lstat(target);
    if (!stat.isFile())
      throw new Error(`Not a file: ${this.displayPath(input)}`);
    this.assertRegularTextFile(stat, target);
    const text = await this.readTextFile(target, stat.size);
    return {
      path: this.relativePath(target),
      content: truncateUtf8(text, MAX_READ_BYTES),
      hash: hash(text),
      truncated: Buffer.byteLength(text, "utf8") > MAX_READ_BYTES,
    };
  }

  private async listFiles(input: string): Promise<Record<string, unknown>> {
    const directory = this.resolvePath(input);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory())
      throw new Error(`Not a directory: ${this.displayPath(input)}`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    let skipped = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (sensitiveComponent(entry.name) || entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (files.length === MAX_LIST_ENTRIES) break;
      files.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
    return {
      path: this.relativePath(directory),
      files,
      truncated: entries.length - skipped > files.length,
      skipped,
    };
  }

  private async search(
    query: string,
    input: string,
  ): Promise<Record<string, unknown>> {
    const root = this.resolvePath(input);
    const stat = await fs.stat(root);
    const matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
    }> = [];
    let scannedFiles = 0;
    let scannedDirectories = 0;
    let skipped = 0;
    let truncated = false;
    const visit = async (current: string): Promise<void> => {
      if (truncated) return;
      const currentStat = await fs.lstat(current);
      if (currentStat.isSymbolicLink()) {
        skipped += 1;
        return;
      }
      if (currentStat.isFile()) {
        if (scannedFiles++ >= MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }
        if (currentStat.size > MAX_SEARCH_FILE_BYTES || currentStat.nlink > 1) {
          skipped += 1;
          return;
        }
        let content: string;
        try {
          content = await this.readTextFile(current, currentStat.size);
        } catch {
          skipped += 1;
          return;
        }
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          let column = lines[index].indexOf(query);
          while (column !== -1) {
            matches.push({
              path: this.relativePath(current),
              line: index + 1,
              column: column + 1,
              text: lines[index].slice(0, 2_000),
            });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              return;
            }
            column = lines[index].indexOf(
              query,
              column + Math.max(query.length, 1),
            );
          }
        }
        return;
      }
      if (!currentStat.isDirectory()) return;
      if (scannedDirectories++ >= MAX_SEARCH_DIRECTORIES) {
        truncated = true;
        return;
      }
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (sensitiveComponent(entry.name) || entry.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        await visit(resolve(current, entry.name));
        if (truncated) return;
      }
    };
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error(`Not searchable: ${this.displayPath(input)}`);
    await visit(root);
    return {
      path: this.relativePath(root),
      query,
      matches,
      scannedFiles,
      scannedDirectories,
      skipped,
      truncated,
    };
  }

  private async writeFile(
    input: string,
    content: string,
    expectedHash: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.throwIfAborted(signal);
    this.assertTextSize(content);
    const target = this.resolvePath(input, true);
    const existing = await this.readExisting(target);
    if (existing === null && expectedHash !== null)
      throw new Error("expectedHash must be null when creating a file");
    if (
      existing !== null &&
      (expectedHash === null || expectedHash !== hash(existing))
    )
      throw new Error("File changed or expectedHash is missing");
    this.throwIfAborted(signal);
    const checkpoint = await this.createCheckpoint(
      target,
      existing,
      content,
      signal,
    );
    await this.atomicWrite(target, content, signal);
    return checkpoint;
  }

  private async patchFile(
    input: string,
    oldText: string,
    newText: string,
    expectedHash: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.throwIfAborted(signal);
    this.assertTextSize(oldText);
    this.assertTextSize(newText);
    const target = this.resolvePath(input);
    const existing = await this.readExisting(target);
    if (existing === null)
      throw new Error(`Missing file: ${this.displayPath(input)}`);
    if (hash(existing) !== expectedHash)
      throw new Error("File changed or expectedHash does not match");
    const first = existing.indexOf(oldText);
    if (first === -1) throw new Error("oldText was not found");
    if (existing.indexOf(oldText, first + oldText.length) !== -1)
      throw new Error("oldText must occur exactly once");
    if (oldText === newText) throw new Error("Patch would not change the file");
    const content = `${existing.slice(0, first)}${newText}${existing.slice(first + oldText.length)}`;
    this.assertTextSize(content);
    this.throwIfAborted(signal);
    const checkpoint = await this.createCheckpoint(
      target,
      existing,
      content,
      signal,
    );
    await this.atomicWrite(target, content, signal);
    return checkpoint;
  }

  private async restore(
    id: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.throwIfAborted(signal);
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(id))
      throw new Error("Invalid checkpoint id");
    await fs.mkdir(this.checkpointDir, { recursive: true });
    this.assertSafeAbsoluteAncestors(this.checkpointDir);
    const filename = resolve(this.checkpointDir, `${id}.json`);
    if (
      relative(this.checkpointDir, filename).startsWith("..") ||
      basename(filename) !== `${id}.json`
    )
      throw new Error("Invalid checkpoint id");
    this.assertNotSymlink(filename);
    let record: Checkpoint;
    try {
      const checkpointStat = await fs.lstat(filename);
      if (
        !checkpointStat.isFile() ||
        checkpointStat.isSymbolicLink() ||
        checkpointStat.size > MAX_CHECKPOINT_BYTES
      )
        throw new Error("Checkpoint not found or invalid");
      record = JSON.parse(
        await this.readTextFile(filename, checkpointStat.size),
      ) as Checkpoint;
    } catch {
      throw new Error("Checkpoint not found or invalid");
    }
    if (!this.validCheckpoint(record))
      throw new Error("Checkpoint does not belong to this workspace");
    const target = this.resolvePath(record.path, true);
    const current = await this.readExisting(target);
    if (current === null || hash(current) !== record.afterHash)
      throw new Error("Refusing to overwrite external edits");
    if (record.beforeContent === null) {
      this.throwIfAborted(signal);
      await fs.unlink(target);
      return { checkpointId: id, path: record.path, restoredHash: null };
    }
    this.throwIfAborted(signal);
    await this.atomicWrite(target, record.beforeContent, signal);
    return {
      checkpointId: id,
      path: record.path,
      restoredHash: record.beforeHash,
    };
  }

  private async createCheckpoint(
    target: string,
    before: string | null,
    after: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await fs.mkdir(this.checkpointDir, { recursive: true });
    this.assertSafeAbsoluteAncestors(this.checkpointDir);
    const checkpointId = randomUUID();
    const path = this.relativePath(target);
    const record: Checkpoint = {
      version: 1,
      workspace: this.workspace,
      path,
      beforeContent: before,
      beforeHash: before === null ? null : hash(before),
      afterHash: hash(after),
    };
    this.throwIfAborted(signal);
    await this.atomicWrite(
      resolve(this.checkpointDir, `${checkpointId}.json`),
      JSON.stringify(record),
      signal,
    );
    return {
      checkpointId,
      path,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
    };
  }

  private validCheckpoint(value: Checkpoint): boolean {
    return (
      value !== null &&
      value.version === 1 &&
      value.workspace === this.workspace &&
      typeof value.path === "string" &&
      value.path.length <= MAX_PATH_LENGTH &&
      (value.beforeContent === null ||
        (typeof value.beforeContent === "string" &&
          !value.beforeContent.includes("\0") &&
          Buffer.byteLength(value.beforeContent, "utf8") <= MAX_TEXT_BYTES)) &&
      (value.beforeHash === null ||
        HashSchema.safeParse(value.beforeHash).success) &&
      HashSchema.safeParse(value.afterHash).success &&
      (value.beforeContent === null
        ? value.beforeHash === null
        : value.beforeHash === hash(value.beforeContent))
    );
  }

  private async readExisting(target: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink())
        throw new Error("Symlinks and junctions are not allowed");
      if (!stat.isFile())
        throw new Error(`Not a regular file: ${this.relativePath(target)}`);
      this.assertRegularTextFile(stat, target);
      return await this.readTextFile(target, stat.size);
    } catch (error: unknown) {
      if (this.isMissing(error)) return null;
      throw error;
    }
  }

  private async atomicWrite(
    target: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertTextSize(content);
    const temporary = resolve(
      target.slice(0, target.lastIndexOf(sep)),
      `.${basename(target)}.${randomUUID()}.tmp`,
    );
    try {
      this.throwIfAborted(signal);
      await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      this.throwIfAborted(signal);
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async runShell(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const directory = this.resolvePath(cwd);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory())
      throw new Error(`Not a directory: ${this.displayPath(cwd)}`);
    if (signal.aborted) throw this.abortError();
    return await this.execution.run(
      { workspace: this.workspace, cwd: directory, command, args, timeoutMs },
      signal,
    );
  }

  private resolvePath(input: string, allowMissingFinal = false): string {
    // Node has no portable openat-style no-follow API, so an external actor can still race these checks after validation.
    if (input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input))
      throw new Error("Absolute paths are not allowed");
    const components = input.replace(/\\/gu, "/").split("/").filter(Boolean);
    for (const component of components) {
      if (component === ".") continue;
      if (component === "..") throw new Error("Path traversal is not allowed");
      if (component.endsWith(".") || component.endsWith(" "))
        throw new Error(
          "Windows trailing-dot and trailing-space aliases are not allowed",
        );
      if (/[<>:"|?*\u0000-\u001f]/u.test(component))
        throw new Error("Windows reserved path characters are not allowed");
      if (isWindowsReserved(component))
        throw new Error("Windows reserved device names are not allowed");
      if (sensitiveComponent(component))
        throw new Error("Sensitive paths are not allowed");
    }
    const target = resolve(this.workspace, input);
    const rel = relative(this.workspace, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Path escapes workspace");
    this.assertSafeComponents(target, allowMissingFinal);
    return target;
  }

  private assertSafeComponents(
    target: string,
    allowMissingFinal: boolean,
  ): void {
    this.assertSafeAbsoluteAncestors(this.workspace);
    const rel = relative(this.workspace, target);
    if (!rel) return;
    const parts = rel.split(sep);
    let current = this.workspace;
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]);
      try {
        this.assertNotSymlink(current);
      } catch (error) {
        if (
          allowMissingFinal &&
          index === parts.length - 1 &&
          this.isMissing(error)
        )
          return;
        throw error;
      }
    }
  }

  private assertNotSymlink(target: string): void {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink())
        throw new Error("Symlinks and junctions are not allowed");
    } catch (error: unknown) {
      if (this.isMissing(error)) return;
      throw error;
    }
  }

  private assertSafeAbsoluteAncestors(target: string): void {
    const absolute = resolve(target);
    const parsed = parse(absolute);
    let current = parsed.root;
    this.assertNotSymlink(current);
    const rest = relative(parsed.root, absolute);
    for (const component of rest.split(sep).filter(Boolean)) {
      current = resolve(current, component);
      try {
        this.assertNotSymlink(current);
      } catch (error) {
        if (this.isMissing(error)) return;
        throw error;
      }
    }
  }

  private assertRegularTextFile(
    stat: { size: number; nlink: number },
    target: string,
  ): void {
    if (stat.size > MAX_TEXT_BYTES)
      throw new Error(
        `File exceeds the ${MAX_TEXT_BYTES}-byte limit: ${this.relativePath(target)}`,
      );
    if (stat.nlink > 1)
      throw new Error(
        `Hard-linked files are not allowed: ${this.relativePath(target)}`,
      );
  }

  private async readTextFile(
    target: string,
    knownSize?: number,
  ): Promise<string> {
    if (knownSize !== undefined && knownSize > MAX_TEXT_BYTES)
      throw new Error(
        `File exceeds the ${MAX_TEXT_BYTES}-byte limit: ${this.relativePath(target)}`,
      );
    const bytes = await fs.readFile(target);
    if (bytes.length > MAX_TEXT_BYTES)
      throw new Error(
        `File exceeds the ${MAX_TEXT_BYTES}-byte limit: ${this.relativePath(target)}`,
      );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `File is not valid UTF-8 text: ${this.relativePath(target)}`,
      );
    }
    if (text.includes("\0"))
      throw new Error(
        `Binary files are not allowed: ${this.relativePath(target)}`,
      );
    return text;
  }

  private assertTextSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES)
      throw new Error(`Content exceeds the ${MAX_TEXT_BYTES}-byte limit`);
    if (content.includes("\0"))
      throw new Error("Binary content is not allowed");
  }

  private relativePath(target: string): string {
    const rel = relative(this.workspace, target);
    return rel === "" ? "." : rel.split(sep).join("/");
  }

  private displayPath(input: string): string {
    return this.relativePath(this.resolvePath(input, true));
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    );
  }

  private abortError(): Error {
    const error = new Error("Shell command aborted");
    error.name = "AbortError";
    return error;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw this.abortError();
  }
}
