"use client";
import { useEffect, useState } from "react";
import {
  runtime,
  RUNTIME_BASE,
  type Task,
  type RuntimeEvent,
} from "../lib/runtime";
const json = (value: unknown) => JSON.stringify(value, null, 2);
const terminal = new Set(["completed", "failed", "canceled", "interrupted"]);
export default function OperatorPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [health, setHealth] = useState("");
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [objective, setObjective] = useState("");
  const [verifyPath, setVerifyPath] = useState("README.md");
  const [verifyText, setVerifyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Restore tab credentials after hydration; server rendering cannot access sessionStorage.
  useEffect(() => {
    const saved = sessionStorage.getItem("operator_runtime_token") ?? "";
    /* eslint-disable react-hooks/set-state-in-effect -- Restore external sessionStorage after SSR hydration. */
    setTokenInput(saved);
    setToken(saved);
    /* eslint-enable react-hooks/set-state-in-effect */
    const controller = new AbortController();
    runtime<{ service: string; provider: string }>("/health", "", {
      signal: controller.signal,
    })
      .then((r) => setHealth(`${r.service} - provider: ${r.provider}`))
      .catch((e) => {
        if (!controller.signal.aborted) setHealth(`Unavailable: ${String(e)}`);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const list = await runtime<{ tasks: Task[] }>("/tasks", token, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setTasks(list.tasks);
        if (selected) {
          const [detail, history] = await Promise.all([
            runtime<{ task: Task }>(
              `/tasks/${encodeURIComponent(selected)}`,
              token,
              { signal: controller.signal },
            ),
            runtime<{ events: RuntimeEvent[] }>(
              `/tasks/${encodeURIComponent(selected)}/events`,
              token,
              { signal: controller.signal },
            ),
          ]);
          if (!controller.signal.aborted) {
            setTask(detail.task);
            setEvents(history.events);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [token, selected, refresh]);
  async function act(path: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await runtime(path, token, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await runtime<{ task: Task }>("/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          objective,
          verification: [
            { kind: "file_contains", path: verifyPath, text: verifyText },
          ],
        }),
      });
      setTask(result.task);
      setSelected(result.task.id);
      setEvents([]);
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function decide(decision: "approve" | "deny", scope: "once" | "task") {
    if (!task?.approval) return;
    void act(`/tasks/${encodeURIComponent(task.id)}/approve`, {
      approvalId: task.approval.id,
      digest: task.approval.digest,
      decision,
      scope,
    });
  }
  return (
    <main className="main-wrap grid runtime-app">
      <header className="row">
        <div>
          <h1>AI Operator</h1>
          <p className="muted">
            Local tasks with explicit verification and reviewable actions.
          </p>
        </div>
        <span className="chip">{health || "Checking runtime..."}</span>
      </header>
      <section className="panel grid">
        <h2>Connect to local runtime</h2>
        <p className="muted">
          {RUNTIME_BASE} - Token stored for this browser tab session.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const value = tokenInput.trim();
            sessionStorage.setItem("operator_runtime_token", value);
            setToken(value);
            setError("");
            setRefresh((v) => v + 1);
          }}
        >
          <label className="runtime-grow">
            Access token
            <input
              required
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
          </label>
          <button className="primary">Connect</button>
          {token && (
            <button
              type="button"
              onClick={() => {
                sessionStorage.removeItem("operator_runtime_token");
                setToken("");
                setTokenInput("");
                setTasks([]);
                setTask(null);
                setSelected("");
                setEvents([]);
              }}
            >
              Disconnect
            </button>
          )}
        </form>
      </section>
      {error && (
        <div className="panel runtime-error" role="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <div className="runtime-columns">
        <aside className="grid runtime-sidebar">
          <form className="panel grid" onSubmit={(e) => void createTask(e)}>
            <h2>Create a task</h2>
            <label>
              Objective
              <textarea
                aria-label="Objective"
                required
                rows={4}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Describe the work and desired outcome"
              />
            </label>
            <h3>Completion criterion</h3>
            <p className="muted">
              Verify that a workspace file contains this text. Empty text checks
              that the file can be read.
            </p>
            <label>
              File path within workspace
              <input
                required
                value={verifyPath}
                onChange={(e) => setVerifyPath(e.target.value)}
              />
            </label>
            <label>
              Required text
              <textarea
                rows={2}
                value={verifyText}
                onChange={(e) => setVerifyText(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={
                !token || busy || !objective.trim() || !verifyPath.trim()
              }
            >
              Create task
            </button>
          </form>
          <section className="panel grid">
            <h2>Tasks</h2>
            <p className="muted">
              {token
                ? "Status updates polled every second."
                : "Connect to view tasks."}
            </p>
            {tasks.map((item) => (
              <button
                key={item.id}
                className={`runtime-task ${selected === item.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(item.id);
                  setTask(item);
                  setEvents([]);
                }}
              >
                <strong>{item.objective}</strong>
                <span>{item.status}</span>
                <small>{item.id}</small>
              </button>
            ))}
            {token && !tasks.length && <p>No tasks loaded.</p>}
          </section>
        </aside>
        <article className="grid runtime-detail">
          {!task ? (
            <section className="panel">
              <h2>Task details</h2>
              <p>
                Create or select a task to inspect its plan, actions, and
                evidence.
              </p>
            </section>
          ) : (
            <>
              <section className="panel grid">
                <div className="row">
                  <h2>{task.objective}</h2>
                  <span className="chip">{task.status}</span>
                </div>
                <p className="mono">{task.id}</p>
                {task.summary && <p>{task.summary}</p>}
                {task.error && (
                  <p className="runtime-error" role="alert">
                    {task.error}
                  </p>
                )}
                <div className="action-row">
                  {task.status === "running" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          `/tasks/${encodeURIComponent(task.id)}/pause`,
                          {},
                        )
                      }
                    >
                      Pause
                    </button>
                  )}
                  {task.status === "paused" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          `/tasks/${encodeURIComponent(task.id)}/resume`,
                          {},
                        )
                      }
                    >
                      Resume
                    </button>
                  )}
                  {!terminal.has(task.status) && (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          `/tasks/${encodeURIComponent(task.id)}/cancel`,
                          {},
                        )
                      }
                    >
                      Cancel task
                    </button>
                  )}
                </div>
                <h3>Plan</h3>
                {task.plan?.length ? (
                  <ol>
                    {task.plan.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                ) : (
                  <p>No plan recorded yet.</p>
                )}
                <h3>Verification criteria</h3>
                <pre>{json(task.verification)}</pre>
              </section>
              {task.approval && (
                <section
                  className="panel grid runtime-approval"
                  aria-label="Action approval"
                >
                  <h2>Action needs approval</h2>
                  <p>{task.approval.reason}</p>
                  <p>
                    <strong>Risk:</strong> {task.approval.risk}
                  </p>
                  <p>
                    <strong>Expires:</strong>{" "}
                    {new Date(task.approval.expiresAt).toLocaleString()}
                  </p>
                  <h3>Resources</h3>
                  <ul>
                    {task.approval.resources.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  <h3>Exact action</h3>
                  <pre>{json(task.approval.call)}</pre>
                  <p className="mono">Digest: {task.approval.digest}</p>
                  <div className="action-row">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => decide("approve", "once")}
                    >
                      Approve once
                    </button>
                    <button
                      disabled={
                        busy || task.approval.risk.toUpperCase() === "HIGH"
                      }
                      onClick={() => decide("approve", "task")}
                    >
                      Allow for this task
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => decide("deny", "once")}
                    >
                      Deny
                    </button>
                  </div>
                </section>
              )}
              <section className="panel grid">
                <h2>Tool observations</h2>
                {task.observations?.length ? (
                  task.observations.map((observation, i) => (
                    <details key={i} open>
                      <summary>
                        Step {observation.step}
                        {observation.error ? " - error" : ""}
                      </summary>
                      <pre>{json(observation)}</pre>
                    </details>
                  ))
                ) : (
                  <p>No tool results recorded.</p>
                )}
              </section>
              <section className="panel grid">
                <h2>Checkpoints</h2>
                <p className="muted">
                  Restore is available after a task stops and creates an action
                  for review.
                </p>
                {task.checkpoints?.length ? (
                  task.checkpoints.map((checkpoint) => (
                    <div className="row" key={checkpoint}>
                      <span className="mono">{checkpoint}</span>
                      <button
                        disabled={busy || !terminal.has(task.status)}
                        onClick={() =>
                          void act(
                            `/tasks/${encodeURIComponent(task.id)}/restore`,
                            { checkpointId: checkpoint },
                          )
                        }
                      >
                        Request restore
                      </button>
                    </div>
                  ))
                ) : (
                  <p>No checkpoints recorded.</p>
                )}
              </section>
              <section className="panel grid">
                <h2>Recorded metrics</h2>
                <pre>{json(task.metrics)}</pre>
              </section>
              <section className="panel grid">
                <h2>Event history</h2>
                {events.length ? (
                  [...events]
                    .sort((a, b) => a.seq - b.seq)
                    .map((event) => (
                      <details key={event.seq}>
                        <summary>
                          {event.seq} - {event.type} -{" "}
                          {new Date(event.at).toLocaleString()}
                        </summary>
                        <pre>{json(event.data)}</pre>
                      </details>
                    ))
                ) : (
                  <p>No events loaded.</p>
                )}
              </section>
            </>
          )}
        </article>
      </div>
    </main>
  );
}
