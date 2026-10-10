"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Re-render the page when the tree on disk changes.
 *
 * It asks /api/tree-version for a fingerprint of the log files. When that
 * changes, `router.refresh()` re-runs `petri export` on the server and updates
 * the page, so a verification run in a terminal appears here by itself.
 */
export function LiveRefresh({ everyMs = 1500 }: { everyMs?: number }) {
  const router = useRouter();
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let seen: string | null = null;
    let stopped = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/tree-version", { cache: "no-store" });
        const { version } = (await res.json()) as { version: string };
        if (seen === null) { seen = version; return; }
        if (version !== seen) {
          seen = version;
          setChanged(true);
          // Tells the tree a record was written. The demo version still waits
          // for the record to reach Hedera before it changes colour.
          window.dispatchEvent(new CustomEvent("petri:detected"));
          router.refresh();
          setTimeout(() => { if (!stopped) setChanged(false); }, 2600);
        }
      } catch {
        // The dev server restarted, or the engine is not installed. Try again later.
      }
    };

    const timer = setInterval(() => void poll(), everyMs);
    void poll();
    return () => { stopped = true; clearInterval(timer); };
  }, [router, everyMs]);

  return changed ? <div className="live-toast" role="status">Verification detected — waiting for Hedera…</div> : null;
}
