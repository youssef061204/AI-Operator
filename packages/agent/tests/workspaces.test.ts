import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskWorkspaceBroker } from "../src/runtime/workspaces.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "operator-worktrees-"));
  const source = path.join(directory, "source"),
    data = path.join(directory, "data");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await writeFile(path.join(source, "a.txt"), "original A");
  await writeFile(path.join(source, "b.txt"), "original B");
  git("add", ".");
  git("commit", "-m", "fixture");
  return {
    source,
    data,
    git,
    broker: new TaskWorkspaceBroker(source, data),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("isolates dirty staged and untracked files; accepts and reverts a multi-file proposal", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "a.txt"), "user staged");
    f.git("add", "a.txt");
    await writeFile(path.join(f.source, "a.txt"), "user unstaged");
    await writeFile(path.join(f.source, "untracked.txt"), "user untracked");
    const index = f.git("show", ":a.txt"),
      head = f.git("rev-parse", "HEAD");
    const task = await f.broker.prepare("dirty");
    assert.equal(
      await readFile(path.join(task.workspace, "a.txt"), "utf8"),
      "user unstaged",
    );
    await writeFile(path.join(task.workspace, "a.txt"), "agent A");
    await unlink(path.join(task.workspace, "b.txt"));
    await writeFile(path.join(task.workspace, "new.txt"), "agent new");
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "user unstaged",
    );
    const changes = await f.broker.changes("dirty");
    assert.equal(changes.files.length, 3);
    assert.equal(
      (await f.broker.accept("dirty", changes.digest)).status,
      "accepted",
    );
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "agent A",
    );
    assert.equal(f.git("show", ":a.txt"), index);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(
      (await f.broker.revert("dirty", changes.digest)).status,
      "reverted",
    );
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "user unstaged",
    );
    assert.equal(
      await readFile(path.join(f.source, "b.txt"), "utf8"),
      "original B",
    );
    assert.equal(
      await readFile(path.join(f.source, "untracked.txt"), "utf8"),
      "user untracked",
    );
    await assert.rejects(readFile(path.join(f.source, "new.txt")), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("preflights every changed file before acceptance and rollback", async () => {
  const f = await fixture();
  try {
    const task = await f.broker.prepare("conflict");
    await writeFile(path.join(task.workspace, "a.txt"), "agent A");
    await writeFile(path.join(task.workspace, "b.txt"), "agent B");
    const changes = await f.broker.changes("conflict");
    await assert.rejects(f.broker.accept("conflict", "stale"), /digest/);
    await writeFile(path.join(f.source, "b.txt"), "external");
    await assert.rejects(
      f.broker.accept("conflict", changes.digest),
      /conflict/,
    );
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "original A",
    );
    await writeFile(path.join(f.source, "b.txt"), "original B");
    await f.broker.accept("conflict", changes.digest);
    await writeFile(path.join(f.source, "b.txt"), "external after acceptance");
    await assert.rejects(
      f.broker.revert("conflict", changes.digest),
      /conflict/,
    );
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "agent A",
    );
  } finally {
    await f.cleanup();
  }
});

test("does not execute repository checkout hooks or attribute filters", async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.source, "hook-ran");
    await writeFile(
      path.join(f.source, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\nprintf attacked > hook-ran\n",
      { mode: 0o755 },
    );
    f.git("config", "filter.evil.smudge", "touch filter-ran");
    f.git("config", "filter.evil.clean", "touch filter-ran");
    f.git("config", "filter.evil.required", "true");
    await writeFile(
      path.join(f.source, ".gitattributes"),
      "*.txt filter=evil\n",
    );
    const task = await f.broker.prepare("hooks");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(task.workspace, "hook-ran")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(f.source, "filter-ran")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(path.join(task.workspace, "a.txt"), "utf8"),
      "original A",
    );
    const changes = await f.broker.changes("hooks");
    assert.equal(
      (await f.broker.discard("hooks", changes.digest)).status,
      "discarded",
    );
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "original A",
    );
  } finally {
    await f.cleanup();
  }
});

test("restart compensates interrupted application and preserves conflicting external edits", async () => {
  const f = await fixture();
  try {
    const task = await f.broker.prepare("recovery");
    await writeFile(path.join(task.workspace, "a.txt"), "agent A");
    await writeFile(path.join(task.workspace, "b.txt"), "agent B");
    const changes = await f.broker.changes("recovery");
    const journalPath = path.join(
      f.data,
      "task-workspaces",
      "recovery",
      "journal.json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.transaction = {
      direction: "accept",
      state: "prepared",
      attempted: ["a.txt", "b.txt"],
    };
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(path.join(f.source, "a.txt"), "agent A");
    await writeFile(path.join(f.source, "b.txt"), "external racing edit");
    const recovered = await new TaskWorkspaceBroker(f.source, f.data).changes(
      "recovery",
    );
    assert.equal(recovered.status, "recovery_required");
    assert.equal(
      await readFile(path.join(f.source, "a.txt"), "utf8"),
      "original A",
    );
    assert.equal(
      await readFile(path.join(f.source, "b.txt"), "utf8"),
      "external racing edit",
    );
    await assert.rejects(
      f.broker.accept("recovery", changes.digest),
      /recovery_required/,
    );
  } finally {
    await f.cleanup();
  }
});
