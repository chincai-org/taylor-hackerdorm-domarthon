/**
 * The tree registry.
 *
 * Six trees: five hand-authored showcase trees, and one read from a real
 * `petri export` snapshot. Both kinds come back from `loadTree()` in the same
 * shape, so nothing downstream has to care which is which.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SHOWCASE_TREES, buildShowcaseTree } from "./data/showcase.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(HERE, "data", name), "utf8"));

/**
 * Every tree the gallery shows. `source` decides where the nodes come from:
 * a showcase key, or the real export snapshot.
 */
export const TREES = [
  { slug: "research--hermes-agent--claude-sonnet-5", harness: "Hermes Agent", model: "Claude Sonnet 5", domain: "Research", goal: "Solve more of 40 research tasks", bench: 40, source: "showcase", showcaseKey: "hermes" },
  { slug: "coding--claude-code--claude-opus-5", harness: "Claude Code", model: "Claude Opus 5", domain: "Coding", goal: "Solve more of 40 coding tasks", bench: 40, source: "showcase", showcaseKey: "claudeCode" },
  { slug: "coding--petri-harness-v1--claude-sonnet-5", harness: "Petri harness v1", model: "Claude Sonnet 5", domain: "Coding", goal: "Solve more of 20 coding tasks", bench: 20, source: "real" },
  { slug: "finance--pi--claude-haiku-4-5", harness: "Pi", model: "Claude Haiku 4.5", domain: "Finance", goal: "Solve more of 20 finance analysis tasks", bench: 20, source: "showcase", showcaseKey: "pi" },
  { slug: "security--codex-cli--gpt-5", harness: "Codex CLI", model: "GPT-5", domain: "Security", goal: "Find more of 40 planted vulnerabilities", bench: 40, source: "showcase", showcaseKey: "codex" },
  { slug: "data-analysis--openhands--gemini-2-5-pro", harness: "OpenHands", model: "Gemini 2.5 Pro", domain: "Data analysis", goal: "Solve more of 40 data analysis tasks", bench: 40, source: "showcase", showcaseKey: "openhands" },
];

/**
 * Drops the parts of a real export the page never reads. Each verification
 * carries five raw run records per side plus a 128-character signature; across
 * the snapshot that is ~170KB of JSON the UI would download and then ignore.
 * Only the medians and the run count are ever shown.
 */
function trimExport(d) {
  return {
    ...d,
    nodes: d.nodes.map((n) => ({
      ...n,
      verifications: n.verifications.map((v) => ({
        reportId: v.reportId,
        hedera: v.hedera ?? null,
        runner: v.runner,
        runnerLabel: v.runnerLabel,
        counted: v.counted,
        ignoredWhy: v.ignoredWhy,
        mode: v.mode,
        runs: v.runs,
        clean: v.clean,
        spreadBp: v.spreadBp,
        deltaMedianBp: v.deltaMedianBp,
        parent: { node: v.parent.node, medianBp: v.parent.medianBp, total: v.parent.total },
        candidate: { node: v.candidate.node, medianBp: v.candidate.medianBp, total: v.candidate.total },
      })),
    })),
  };
}

let realCache = null;

/** The snapshot, trimmed, read once. */
function realExport() {
  realCache ??= { tree: trimExport(readJson("petri-export.json")), digest: readJson("petri-digest.json") };
  return realCache;
}

/** The full tree for one gallery entry, plus its digest when it has one. */
export function loadTree(entry) {
  if (entry.source === "showcase") {
    return { tree: buildShowcaseTree(SHOWCASE_TREES[entry.showcaseKey]), digest: null };
  }
  const { tree, digest } = realExport();
  return { tree, digest };
}
