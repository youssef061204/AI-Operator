import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceTools, hash } from "../src/runtime/tools.js";

async function fixture(): Promise<{
  root: string;
  checkpoints: string;
  tools: WorkspaceTools;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "workspace-tools-"));
  const root = join(directory, "workspace");
  const checkpoints = join(directory, "checkpoints");
  await mkdir(root);
  return {
    root,
    checkpoints,
    tools: new WorkspaceTools(root, checkpoints),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch {
      await new Promise<void>((done) => setTimeout(done, 20));
    }
  }
  throw new Error("Child process did not write its pid");
}

test("rejects traversal, sensitive aliases, and Windows wildcard paths", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "../outside" },
        new AbortController().signal,
      ),
      /traversal|escapes/i,
    );
    await assert.rejects(
      f.tools.execute(
        { tool: "list_files", path: ".git" },
        new AbortController().signal,
      ),
      /Sensitive/i,
    );
    await assert.rejects(
      f.tools.execute(
        { tool: "list_files", path: ".git " },
        new AbortController().signal,
      ),
      /trailing/i,
    );
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "file*.txt" },
        new AbortController().signal,
      ),
      /reserved path characters/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("rejects symlinks and Windows junctions", async (t) => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "file.txt"), "safe");
    try {
      await symlink(join(f.root, "file.txt"), join(f.root, "linked.txt"));
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        t.skip("Windows account does not permit creating symlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "linked.txt" },
        new AbortController().signal,
      ),
      /Symlink/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("rejects a Windows junction without requiring symlink privilege", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Junctions are a Windows filesystem feature");
    return;
  }
  const f = await fixture();
  try {
    await mkdir(join(f.root, "target"));
    await symlink(join(f.root, "target"), join(f.root, "junction"), "junction");
    await assert.rejects(
      f.tools.execute(
        { tool: "list_files", path: "junction" },
        new AbortController().signal,
      ),
      /Symlink|junction/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("write and patch enforce hashes and checkpoint restoration refuses conflicts", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "note.txt"), "one");
    await assert.rejects(
      f.tools.execute(
        {
          tool: "write_file",
          path: "note.txt",
          content: "two",
          expectedHash: null,
        },
        new AbortController().signal,
      ),
      /expectedHash/i,
    );
    await assert.rejects(
      f.tools.execute(
        {
          tool: "write_file",
          path: "note.txt",
          content: "two",
          expectedHash: hash("stale"),
        },
        new AbortController().signal,
      ),
      /changed/i,
    );
    const saved = await f.tools.execute(
      {
        tool: "patch_file",
        path: "note.txt",
        oldText: "one",
        newText: "two",
        expectedHash: hash("one"),
      },
      new AbortController().signal,
    );
    const checkpointId = String(saved.checkpointId);
    assert.equal(await readFile(join(f.root, "note.txt"), "utf8"), "two");
    await f.tools.execute(
      { tool: "restore", checkpointId },
      new AbortController().signal,
    );
    assert.equal(await readFile(join(f.root, "note.txt"), "utf8"), "one");
    const changed = await f.tools.execute(
      {
        tool: "write_file",
        path: "note.txt",
        content: "two",
        expectedHash: hash("one"),
      },
      new AbortController().signal,
    );
    await writeFile(join(f.root, "note.txt"), "external");
    await assert.rejects(
      f.tools.execute(
        { tool: "restore", checkpointId: String(changed.checkpointId) },
        new AbortController().signal,
      ),
      /external edits/i,
    );
    await assert.rejects(
      f.tools.execute(
        {
          tool: "patch_file",
          path: "missing.txt",
          oldText: "x",
          newText: "y",
          expectedHash: hash("x"),
        },
        new AbortController().signal,
      ),
      /Missing/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("patch requires one literal occurrence and creates are explicit", async () => {
  const f = await fixture();
  try {
    const created = await f.tools.execute(
      { tool: "write_file", path: "new.txt", content: "x", expectedHash: null },
      new AbortController().signal,
    );
    assert.equal(created.beforeHash, null);
    await writeFile(join(f.root, "duplicate.txt"), "same same");
    await assert.rejects(
      f.tools.execute(
        {
          tool: "patch_file",
          path: "duplicate.txt",
          oldText: "same",
          newText: "other",
          expectedHash: hash("same same"),
        },
        new AbortController().signal,
      ),
      /exactly once/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("read, list, and search bound output and skip sensitive entries", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "large.txt"), "a".repeat(70 * 1024));
    await writeFile(join(f.root, "match.txt"), "needle here\nneedle again");
    await mkdir(join(f.root, ".env-secret"));
    await writeFile(join(f.root, ".env-secret", "hidden.txt"), "needle hidden");
    const read = await f.tools.execute(
      { tool: "read_file", path: "large.txt" },
      new AbortController().signal,
    );
    assert.equal(read.truncated, true);
    assert.equal((read.content as string).length <= 64 * 1024, true);
    const list = await f.tools.execute(
      { tool: "list_files", path: "." },
      new AbortController().signal,
    );
    assert.equal(
      (list.files as string[]).some((name) => name.includes(".env-secret")),
      false,
    );
    const found = await f.tools.execute(
      { tool: "search", query: "needle", path: "." },
      new AbortController().signal,
    );
    assert.equal(
      (found.matches as Array<{ path: string }>).every(
        (match) => match.path !== ".env-secret/hidden.txt",
      ),
      true,
    );
    assert.equal((found.matches as unknown[]).length, 2);
    await writeFile(join(f.root, "too-large.txt"), "a".repeat(1024 * 1024 + 1));
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "too-large.txt" },
        new AbortController().signal,
      ),
      /exceeds/i,
    );
    await writeFile(join(f.root, "binary.txt"), Buffer.from([0xff, 0x00]));
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "binary.txt" },
        new AbortController().signal,
      ),
      /UTF-8|Binary/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("rejects hard-linked files and already-aborted mutations", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "original.txt"), "private");
    await link(join(f.root, "original.txt"), join(f.root, "linked-copy.txt"));
    await assert.rejects(
      f.tools.execute(
        { tool: "read_file", path: "linked-copy.txt" },
        new AbortController().signal,
      ),
      /Hard-linked/i,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.tools.execute(
        {
          tool: "write_file",
          path: "cancelled.txt",
          content: "no",
          expectedHash: null,
        },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    await assert.rejects(readFile(join(f.root, "cancelled.txt"), "utf8"));
  } finally {
    await f.cleanup();
  }
});

test("shell uses literal args, bounded output, scrubbed environment, and reports exits", async () => {
  const f = await fixture();
  const secretKey = "WORKSPACE_TOOLS_TEST_SECRET";
  const previous = process.env[secretKey];
  process.env[secretKey] = "do-not-leak";
  try {
    const literal = await f.tools.execute(
      {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", "$(not-a-shell)"],
        cwd: ".",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    assert.equal(literal.stdout, "$(not-a-shell)");
    const environment = await f.tools.execute(
      {
        tool: "shell",
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(process.env.${secretKey} || 'clean')`,
        ],
        cwd: ".",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    assert.equal(environment.stdout, "clean");
    const exit = await f.tools.execute(
      {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "process.stderr.write('failure');process.exit(7)"],
        cwd: ".",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    assert.equal(exit.exitCode, 7);
    assert.equal(exit.stderr, "failure");
    const large = await f.tools.execute(
      {
        tool: "shell",
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(70000))"],
        cwd: ".",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    assert.equal(large.stdoutTruncated, true);
    assert.equal((large.stdout as string).length <= 64 * 1024, true);
  } finally {
    if (previous === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previous;
    await f.cleanup();
  }
});

test("shell handles spawn errors, timeout, and cancellation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.tools.execute(
        {
          tool: "shell",
          command: "definitely-not-a-real-executable",
          args: [],
          cwd: ".",
          timeoutMs: 1_000,
        },
        new AbortController().signal,
      ),
    );
    await assert.rejects(
      f.tools.execute(
        {
          tool: "shell",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: ".",
          timeoutMs: 50,
        },
        new AbortController().signal,
      ),
      /timed out/i,
    );
    const controller = new AbortController();
    const pidFile = join(f.root, "child.pid");
    const running = f.tools.execute(
      {
        tool: "shell",
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(() => {}, 1000)",
          pidFile,
        ],
        cwd: ".",
        timeoutMs: 5_000,
      },
      controller.signal,
    );
    const childPid = await waitForPid(pidFile);
    controller.abort();
    await assert.rejects(running, { name: "AbortError" });
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    await f.cleanup();
  }
});
