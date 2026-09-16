"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { runtime } from "../../lib/runtime";

type RecordItem = { name: string; result: Record<string, unknown> };

export default function EvaluationsPage() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    runtime<{ records: RecordItem[] }>("/evaluations", "")
      .then((result) => setRecords(result.records))
      .catch((reason) => setError(String(reason)));
  }, []);
  return (
    <main className="main-wrap grid runtime-app">
      <header className="row">
        <div>
          <h1>Evaluation evidence</h1>
          <p className="muted">
            Generated artifacts only. Scripted runtime safety and live model
            capability are reported separately.
          </p>
        </div>
        <Link href="/">Back to tasks</Link>
      </header>
      {error && <div className="panel runtime-error">{error}</div>}
      {!records.length && !error && (
        <section className="panel">
          <h2>No results yet</h2>
          <p>
            Run the deterministic evaluation or live benchmark to generate
            measurements.
          </p>
        </section>
      )}
      {records.map(({ name, result }) => (
        <section className="panel grid" key={name}>
          <h2>
            {name.includes("live-benchmark")
              ? "Live Gemini Coding Capability"
              : name.includes("benchmark-integrity")
                ? "Coding Benchmark Integrity"
                : name.includes("latest")
                  ? "Deterministic Runtime/Safety Evaluation"
                  : name}
          </h2>
          <p className="muted">{name}</p>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ))}
    </main>
  );
}
