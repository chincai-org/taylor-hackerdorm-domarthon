"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SelfieDemoResult } from "@/lib/selfie-demo";

type Phase = "idle" | "scanning" | "sending" | "done" | "error";

const short = (s: string, head = 10, tail = 6) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

export function SelfieDemo({ node, short: nodeShort, status, hypothesis, report, treeHref }: {
  node: string;
  short: string;
  status: string | null;
  hypothesis: string | null;
  report: string;
  treeHref: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<SelfieDemoResult | null>(null);

  const start = useCallback(async () => {
    if (phase !== "idle" || node === "") return;
    setPhase("scanning");
    await new Promise((r) => setTimeout(r, 1400));
    setPhase("sending");
    try {
      const res = await fetch("/api/selfie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node, report }),
      });
      const data = (await res.json()) as SelfieDemoResult;
      setResult(data);
      setPhase(data.ok ? "done" : "error");
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message, record: null });
      setPhase("error");
    }
  }, [phase, node, report]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code !== "Space" || t?.closest("input, textarea, select, button, a")) return;
      e.preventDefault();
      void start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start]);

  const done = phase === "done" && result?.ok ? result : null;

  return (
    <div className="selfie-grid">
      <section className="plate selfie-card">
        <div className="selfie-title">
          <h2>World ID · Selfie Check</h2>
          <span className="tag tag-example">Simulated</span>
        </div>

        <dl className="selfie-facts">
          <div><dt>Version</dt><dd><code>{nodeShort || "—"}</code>{status && <small>{status}</small>}</dd></div>
          <div><dt>Signed report</dt><dd><code>{report ? short(report) : "—"}</code></dd></div>
        </dl>
        {hypothesis && <p className="selfie-hyp">{hypothesis}</p>}

        <div className={`selfie-face s-${phase}`} aria-hidden="true">
          <div className="selfie-ring" />
          <span className="selfie-glyph">{phase === "done" ? "✓" : phase === "error" ? "!" : "☺"}</span>
        </div>

        <p className="selfie-state" aria-live="polite">
          {phase === "idle" && (node ? "Ready. The verifier looks at the camera." : "Open this page from the link that petri verify prints.")}
          {phase === "scanning" && "Checking the selfie…"}
          {phase === "sending" && "Verified. Sending the record to Hedera…"}
          {phase === "done" && "Verified human. The record is on Hedera."}
          {phase === "error" && "The check did not finish."}
        </p>

        {phase === "idle" && (
          <button type="button" className="btn btn-primary selfie-btn" onClick={() => void start()} disabled={!node}>
            Verify with Selfie Check <kbd>Space</kbd>
          </button>
        )}
        <p className="muted selfie-note">Demo mode: no World App scan runs here. The record is sent to Hedera with <code>simulated: true</code>. The real flow uses IDKit <code>selfieCheckLegacy()</code>.</p>
      </section>

      <section className="plate selfie-card">
        <div className="selfie-title"><h2>Hedera record</h2>{done && <span className="tag tag-real">On chain</span>}</div>

        {!done && phase !== "error" && (
          <p className="muted">{phase === "sending" ? "Waiting for consensus and the mirror node…" : "The transaction hash appears here after the check."}</p>
        )}

        {phase === "error" && result && !result.ok && (
          <pre className="selfie-error">{result.error}</pre>
        )}

        {done && (
          <>
            <dl className="selfie-hash">
              <div><dt>Transaction id</dt><dd><code>{done.hedera.txId}</code></dd></div>
              {done.hedera.runningHash && <div><dt>Running hash</dt><dd><code>{done.hedera.runningHash}</code></dd></div>}
              <div><dt>Topic</dt><dd><code>{done.hedera.topicId}</code> · message #{done.hedera.hcsSeq} · {done.hedera.network}</dd></div>
              {done.hedera.consensusTimestamp && <div><dt>Consensus time</dt><dd><code>{done.hedera.consensusTimestamp}</code></dd></div>}
              <div><dt>Nullifier</dt><dd><code>{short(done.record.nullifier, 14, 8)}</code></dd></div>
            </dl>
            {done.hedera.sentWithIt > 0 && (
              <p className="muted">The verification report went to the same topic in this push, with {done.hedera.sentWithIt} other {done.hedera.sentWithIt === 1 ? "record" : "records"}.</p>
            )}
            <div className="selfie-links">
              <a className="btn" href={done.hedera.hashscan} target="_blank" rel="noreferrer">Open in HashScan ↗</a>
              <a className="btn" href={done.hedera.mirror} target="_blank" rel="noreferrer">Mirror node JSON ↗</a>
              <Link className="btn" href={treeHref}>Back to the tree</Link>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
