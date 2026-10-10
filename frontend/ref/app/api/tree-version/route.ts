import { statSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { PETRI_ROOT } from "@/lib/tree";

export const dynamic = "force-dynamic";

/** Files that change when a version, a verification or a Hedera receipt is written. */
const WATCHED = ["log.jsonl", "world-checks.jsonl", "anchors.jsonl", "anchor-times.json"];

/**
 * A cheap fingerprint of the tree on disk.
 *
 * The page polls this and re-renders itself when the value changes, so a
 * `petri verify` in a terminal shows up in the browser by itself.
 */
export function GET() {
  const parts = WATCHED.map((name) => {
    try {
      const s = statSync(path.join(PETRI_ROOT, ".petri", name));
      return `${name}:${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {
      return `${name}:none`;
    }
  });
  return NextResponse.json({ version: parts.join("|") }, { headers: { "cache-control": "no-store" } });
}
