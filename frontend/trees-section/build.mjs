/**
 * Generates the static site: the gallery (`index.html`) and one detail page per
 * tree (`tree/<slug>.html`).
 *
 * Why a build step: a tidy tree's row layout depends on how many leaves sit
 * above a node, and the detail page needs every version's record. Solving that
 * here means each page ships as complete, static HTML — readable with
 * JavaScript off — and the browser script is left free to do nothing but polish.
 *
 * Run with:  node build.mjs
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { TREES, loadTree } from "./data.mjs";
import { buildForest, tidySlots } from "./lib/layout.mjs";
import { glyph } from "./lib/glyph.mjs";
import { changesOf, fmtPct } from "./lib/metrics.mjs";
import { OBJECTIVES } from "./lib/objectives.mjs";
import {
  STATUS_WORD, claimBp, clip, counted, ignored, isBlocked, isRoot, nodeNumbers,
  objectiveOf, rootRerunBp, signedBp, tasks, tasksOf, wordOf,
} from "./lib/format.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Rounds to one decimal so emitted path data stays short and stable. */
const r1 = (v) => Math.round(v * 10) / 10;

/** Escapes text destined for markup, so a stray "&" can never break the page. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A version is dead when it will never be re-run as-is. */
const DEAD = new Set(["rejected", "withdrawn", "superseded"]);

/* ------------------------------------------------------------------ *
 * The gallery card
 * ------------------------------------------------------------------ */

/** Mini-tree geometry, in SVG user units. The SVG is scaled to fit its card. */
const MINI = { COL: 70, ROW: 24, PAD: 16, R: 5 };

/** Draws a whole tree as one inline SVG. Decorative: the card text carries the meaning. */
function miniTree(nodes) {
  const { COL, ROW, PAD, R } = MINI;
  const forest = buildForest(nodes);
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));

  // A minimum canvas keeps a one-version tree as a small centred dot instead of
  // stretching it across the card.
  const cols = Math.max(maxDepth, 3);
  const spanRows = Math.max(rows - 1, 3);
  const dx = ((cols - maxDepth) * COL) / 2;
  const dy = ((spanRows - (rows - 1)) * ROW) / 2;

  const at = (id) => {
    const slot = slots.get(id);
    return { x: PAD + dx + slot.depth * COL, y: PAD + dy + slot.row * ROW };
  };

  const edges = nodes
    .filter((n) => slots.has(n.parent) && slots.has(n.id))
    .map((n) => {
      const a = at(n.parent);
      const b = at(n.id);
      const mx = r1((a.x + b.x) / 2);
      const cls = n.status === "rejected" ? "h-edge dead" : "h-edge";
      return `<path class="${cls}" d="M${r1(a.x)} ${r1(a.y)}C${mx} ${r1(a.y)} ${mx} ${r1(b.y)} ${r1(b.x)} ${r1(b.y)}"/>`;
    })
    .join("");

  const glyphs = nodes
    .filter((n) => slots.has(n.id))
    .map((n) => {
      const { x, y } = at(n.id);
      return glyph(n.status, x, y, R);
    })
    .join("");

  const width = PAD * 2 + cols * COL;
  const height = PAD * 2 + spanRows * ROW;
  return `<svg class="mini" viewBox="0 0 ${width} ${height}" aria-hidden="true">${edges}${glyphs}</svg>`;
}

/** The four numbers on a gallery card. `best` is the score of the head version. */
function cardStats(tree) {
  const { bench, stats } = tree;
  // `stats.head` is the one definition of "the best version" — the same value
  // the tree page opens on and the info panels read. Do not recompute it here.
  const head = tree.nodes.find((n) => n.id === stats.head);
  return {
    total: stats.total,
    accepted: stats.accepted,
    rejected: stats.rejected,
    best: head ? `${tasksOf(head.detail.claimedMedianBp, bench.total)} of ${bench.total}` : "\u2014",
  };
}

function galleryCard(entry, tree) {
  const stats = cardStats(tree);
  return `
        <li>
          <a class="card" href="${esc(entry.slug)}.html">
            <div class="card-top">
              <div>
                <p class="card-title">${esc(entry.harness)}</p>
                <p class="card-sub">on ${esc(entry.model)}</p>
              </div>
              <span class="tag">${esc(entry.domain)}</span>
            </div>
            <div class="card-mini">${miniTree(tree.nodes)}</div>
            <p class="card-goal">${esc(entry.goal)}</p>
            <dl class="card-stats">
              <div><dt>Versions</dt><dd>${stats.total}</dd></div>
              <div><dt>Accepted</dt><dd>${stats.accepted}</dd></div>
              <div><dt>Kept failures</dt><dd>${stats.rejected}</dd></div>
              <div><dt>Best</dt><dd>${esc(stats.best)}</dd></div>
            </dl>
          </a>
        </li>`;
}

/* ------------------------------------------------------------------ *
 * The big lineage figure
 * ------------------------------------------------------------------ */

const HERO = { COL: 420, ROW: 74, PAD_X: 40, PAD_Y: 46, LABEL_W: 300, R: 8 };

/**
 * The one-pager's Figure 1, drawn large: a tidy tree with S-curves from parent
 * to child. Each version is a link to its own record, so the figure is fully
 * navigable with JavaScript off; the script only makes the jump instant.
 */
function heroTree(tree, bench) {
  const { COL, ROW, PAD_X, PAD_Y, LABEL_W, R } = HERO;
  const { nodes, policy } = tree;
  const forest = buildForest(nodes);
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));

  const at = (id) => {
    const s = slots.get(id);
    return { x: PAD_X + s.depth * COL, y: PAD_Y + s.row * ROW };
  };
  const width = PAD_X * 2 + maxDepth * COL + LABEL_W;
  const height = PAD_Y * 2 + (rows - 1) * ROW;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Where a branch rejoins the accepted line.
  //
  // A version whose parent was rejected often restores an earlier harness: the
  // files it runs hash to the same id as an accepted ancestor, so the two run
  // exactly the same code. Walk up past the rejected parent to that ancestor.
  const restoredAncestor = (n) => {
    const seen = new Set();
    let cur = byId.get(n.parent);
    while (cur !== undefined && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.status === "accepted" && cur.harness === n.harness) return cur.id;
      cur = byId.get(cur.parent);
    }
    return "";
  };
  const restores = nodes
    .filter((n) => DEAD.has(byId.get(n.parent)?.status ?? "") && n.harness !== undefined)
    .map((n) => ({ from: restoredAncestor(n), to: n.id }))
    .filter((e) => e.from !== "" && slots.has(e.from) && slots.has(e.to));

  const curved = (a, b) => `M${a.x + R} ${a.y}C${r1((a.x + b.x) / 2)} ${a.y} ${r1((a.x + b.x) / 2)} ${b.y} ${b.x - R} ${b.y}`;

  const edges = nodes
    .filter((n) => slots.has(n.parent) && slots.has(n.id))
    .map((n) => `<path class="${DEAD.has(n.status) ? "h-edge dead" : "h-edge"}" d="${curved(at(n.parent), at(n.id))}"/>`)
    .join("");

  const restoreEdges = restores
    .map(({ from, to }) => `<path class="h-edge restore" d="${curved(at(from), at(to))}"><title>runs the same harness as ${esc(from.slice(0, 8))}</title></path>`)
    .join("");

  // The direction each change aimed for, on the line just before the child.
  const objectives = nodes
    .filter((n) => slots.has(n.parent) && slots.has(n.id))
    .map((n) => {
      const b = at(n.id);
      const local = changesOf(n, nodes).local;
      const label = local === null ? objectiveOf(n) : `${objectiveOf(n)} ${fmtPct(local)}`;
      // Roboto Mono advances 0.6em, so a 9.5px glyph is 5.7px wide. 5.8 keeps a
      // little slack; the box would clip the text at 5.5.
      const w = r1(label.length * 5.8 + 14);
      return `<g class="objective"><rect x="${r1(b.x - R - 10 - w)}" y="${r1(b.y - 8)}" width="${w}" height="16" rx="8"/><text x="${r1(b.x - R - 10 - w / 2)}" y="${r1(b.y + 3.2)}" text-anchor="middle">${esc(label)}</text></g>`;
    })
    .join("");

  const groups = nodes
    .filter((n) => slots.has(n.id))
    .map((n) => {
      const { x, y } = at(n.id);
      const word = `${wordOf(n)} \u00b7 ${n.short}`;
      const hyp = clip(n.hypothesis, 32);
      const num = nodeNumbers(n, nodes, bench.total, policy.minVerifications);
      // White blocks behind the label lines. Edges are drawn first, so an edge
      // running under a label is hidden there and reappears past it.
      const labelW = Math.min(LABEL_W - 20, Math.max(word.length * 6.3, hyp.length * 6.9, num.length * 6.6) + 8);

      // Two backdrop blocks with an open band at the dot height, so a straight
      // edge stays visible between the hypothesis above and the numbers below.
      return `<a class="h-node s-${n.status}" href="#s-${esc(n.short)}" aria-label="${esc(`${STATUS_WORD[n.status]} ${n.short}. ${n.hypothesis}`)}">
              <rect class="backdrop" x="${r1(x + 14)}" y="${r1(y - 27)}" width="${r1(labelW)}" height="26"/>
              <rect class="backdrop" x="${r1(x + 14)}" y="${r1(y + 7)}" width="${r1(labelW)}" height="14"/>
              <rect class="hit" x="${r1(x - 16)}" y="${r1(y - 31)}" width="${LABEL_W - 6}" height="56" rx="6"/>
              <circle class="ring" cx="${r1(x)}" cy="${r1(y)}" r="${R + 5}"/>
              ${glyph(n.status, x, y, R)}
              <text class="h-word" x="${r1(x + 18)}" y="${r1(y - 17)}">${esc(word)}</text>
              <text class="h-hyp" x="${r1(x + 18)}" y="${r1(y - 3)}">${esc(hyp)}</text>
              <text class="h-num" x="${r1(x + 18)}" y="${r1(y + 18)}">${esc(num)}</text>
            </a>`;
    })
    .join("");

  return `<div class="hero">
          <svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Lineage of ${nodes.length} harness versions" style="max-inline-size:${width}px;min-inline-size:${Math.round(width * 0.78)}px">
            ${edges}${restoreEdges}${objectives}${groups}
          </svg>
        </div>`;
}

/** The same lineage as a vertical list, for narrow screens. */
function treeList(tree, bench) {
  const { nodes, policy } = tree;
  const forest = buildForest(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const branch = (id) => {
    const n = byId.get(id);
    if (!n) return "";
    const kids = forest.children.get(id) ?? [];
    const num = nodeNumbers(n, nodes, bench.total, policy.minVerifications);
    return `<li class="t-node s-${n.status}${DEAD.has(n.status) ? " dead" : ""}">
            <a class="t-row" href="#s-${esc(n.short)}">
              <svg class="t-glyph" width="16" height="16" aria-hidden="true">${glyph(n.status, 8, 8, 5.5)}</svg>
              <span class="t-text">
                <span class="t-word">${esc(`${wordOf(n)} \u00b7 ${n.short}`)}</span>
                <span class="t-hyp">${esc(n.hypothesis)}</span>
                <span class="t-num">${esc(num)}</span>
              </span>
            </a>
            ${kids.length > 0 ? `<ul>${kids.map(branch).join("")}</ul>` : ""}
          </li>`;
  };

  return `<ul class="tree list-view" aria-label="Lineage of ${nodes.length} harness versions">
          ${forest.roots.map(branch).join("")}
        </ul>`;
}

/* ------------------------------------------------------------------ *
 * The selected-version strip
 * ------------------------------------------------------------------ */

/**
 * The bar under the tree. It is the visible summary of the chosen version, and
 * it is where the figure's links land, so scrolling to a version and choosing it
 * are the same action.
 *
 * The strip deliberately does NOT carry the `s-<short>` id. That id sits on the
 * matching record article further down the page (see `records` in `treePage`),
 * because a fragment can only mean one thing: if the strip owned the id, then
 * "Full record ↓" would have to point somewhere else — and any other fragment
 * matches no strip, which sends the page back to its default and silently undoes
 * the choice. With the id on the record, `#s-he-07` both selects the version and
 * scrolls to it, and the strip comes along because the generated rules tie the
 * two together.
 */
function selectedStrip(n, tree) {
  const { nodes, policy, bench } = tree;
  return `<div class="selected-strip s-${n.status}" data-for="${esc(n.short)}"${n.id === tree.stats.head ? " data-default" : ""}>
            <svg width="14" height="14" aria-hidden="true">${glyph(n.status, 7, 7, 5)}</svg>
            <span class="sel-word">${esc(`${wordOf(n)} \u00b7 ${n.short}`)}</span>
            <span class="sel-hyp">${esc(clip(n.hypothesis, 96))}</span>
            <span class="sel-num">${esc(nodeNumbers(n, nodes, bench.total, policy.minVerifications))}</span>
            <a href="#s-${esc(n.short)}">Full record \u2193</a>
          </div>`;
}

/* ------------------------------------------------------------------ *
 * The copy control
 * ------------------------------------------------------------------ */

/**
 * A copy button whose face is a clipboard icon, not a word.
 *
 * Both glyphs ship in the markup and CSS picks which is visible, so the swap on
 * success needs no DOM building and the icon is present before the script runs.
 * That is also why the label is `aria-label` and not text: the button has no
 * text content to announce, and an icon-only control with no accessible name is
 * a dead end for a screen reader.
 *
 * `data-copy` is a literal string to copy; `data-copy-out` names a
 * `[data-fork-out]` element whose current text is copied instead (the fork
 * command changes with the direction picker, so it cannot be baked in).
 */
const COPY_ICON = `<svg class="icon-copy" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M9 2h6a1.5 1.5 0 0 1 0 3H9a1.5 1.5 0 0 1 0-3Z" />
                <path d="M6.5 3.6A2.5 2.5 0 0 0 4 6.1v12.4A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V6.1a2.5 2.5 0 0 0-2.5-2.5h-.4" />
                <path d="M8 11.5h8" />
                <path d="M8 15.5h5" />
              </svg>`;

const COPY_DONE_ICON = `<svg class="icon-copied" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M5 12.8 9.8 17.5 19 7" />
              </svg>`;

const copyButton = (attributes, label) =>
  `<button type="button" class="icon-btn copy needs-js" ${attributes} aria-label="${esc(label)}" title="${esc(label)}">
                ${COPY_ICON}
                ${COPY_DONE_ICON}
              </button>`;

/* ------------------------------------------------------------------ *
 * The record panel
 * ------------------------------------------------------------------ */

/**
 * The fork command, spelled out once. `main.js` fills the two placeholders when
 * the direction changes, so the wording lives here only — the script never
 * carries its own copy of the command to drift out of sync.
 */
const forkTemplate = (short, area) =>
  `pnpm petri propose --parent ${short} --area ${area} --motif {{motif}} \\\n  --hypothesis "This change improves {{direction}}, because ..."`;

const fillFork = (template, direction) =>
  template.replaceAll("{{motif}}", direction.replace(/\s+/g, "-")).replaceAll("{{direction}}", direction);

/**
 * Branch from this version toward your own direction. Prints the real CLI command.
 *
 * The command and its copy button share one `.cmd` box so the button sits inside
 * the command field rather than under it. `data-fork-out` must stay on the `<pre>`:
 * `main.js` rewrites that element's `textContent` when the direction changes, and
 * pointing it at the wrapper would wipe the button out of the DOM.
 */
function fork(n) {
  const template = forkTemplate(n.short, n.detail.proposal.primaryArea);
  const options = OBJECTIVES.map((o, i) => `<option value="${esc(o)}"${i === 0 ? " selected" : ""}>${esc(o)}</option>`).join("");
  return `<div class="np-block fork">
            <h3>Fork this version</h3>
            <p class="muted">Copy it, change one idea toward your own goal, and submit it. Your fork becomes a new branch.</p>
            <label class="fork-row needs-js" for="fork-${esc(n.short)}">
              <span>Direction</span>
              <select id="fork-${esc(n.short)}" data-fork="${esc(n.short)}" data-template="${esc(template)}">${options}</select>
            </label>
            <div class="cmd">
              <pre data-fork-out="${esc(n.short)}">${esc(fillFork(template, OBJECTIVES[0]))}</pre>
              ${copyButton(`data-copy-out="${esc(n.short)}"`, "Copy the fork command")}
            </div>
          </div>`;
}

/** The commands anyone can run, in the order the demo follows. */
const checkSteps = (short, hasTopic, scored) => [
  { what: "How it works", why: "The record every agent reads before it proposes a change: what won, what failed, and why.", cmds: ["pnpm petri digest"] },
  {
    what: "Run it",
    why: scored
      ? "The harness reads a task, the model writes the code, the tests run in the sandbox. 3 tasks by default, and nothing is signed."
      : "This version has no recorded answers, so it runs only against a real model. It needs ANTHROPIC_API_KEY.",
    cmds: [scored ? `pnpm petri run ${short}` : `ANTHROPIC_API_KEY=... pnpm petri run ${short} --mode live`],
  },
  {
    what: "Evals",
    why: scored
      ? "The whole benchmark, 5 times: every task passed or failed, and the median score."
      : "The whole benchmark, 5 times, against a real model. Replay cannot score this version.",
    cmds: [scored ? `pnpm petri evals ${short}` : `ANTHROPIC_API_KEY=... pnpm petri evals ${short} --mode live`],
  },
  {
    what: "Verify it",
    why: scored
      ? "Your key re-runs this version and its parent, then signs the result. The author's own key is refused."
      : "A version with no score cannot be verified. Score it live first, then another key signs it.",
    cmds: ["PETRI_HOME=~/my-verifier pnpm petri id create --label me", `PETRI_HOME=~/my-verifier pnpm petri verify ${short} --show`],
  },
  {
    what: "Check the record",
    why: hasTopic ? "Every signature and the hash chain, then the public Hedera copy compared byte for byte." : "Every signature and the hash chain of the log.",
    cmds: hasTopic ? ["pnpm petri fsck", "pnpm petri hedera check"] : ["pnpm petri fsck"],
  },
];

function checkIt(n, hasTopic) {
  const scored = !isBlocked(n);
  const steps = checkSteps(n.short, hasTopic, scored)
    .map(
      (s) => `<li>
              <p class="checkit-what">${esc(s.what)}</p>
              <p class="muted">${esc(s.why)}</p>
              ${s.cmds
                .map(
                  (cmd) => `<div class="cmd checkit-cmd">
                <code>${esc(cmd)}</code>
                ${copyButton(`data-copy="${esc(cmd)}"`, `Copy the command: ${cmd}`)}
              </div>`,
                )
                .join("")}
            </li>`,
    )
    .join("");

  return `<div class="np-block checkit">
            <h3>Check it yourself</h3>
            <p class="muted">Clone the repo, then run these from the repository root. Nothing here needs an API key.</p>
            <ol class="checkit-steps">${steps}</ol>
          </div>`;
}

/** HashScan links, so a reader can check a record on the public topic. */
const hashscanRecord = (topic, ref) =>
  ref.timestamp ? `https://hashscan.io/${topic.network}/transaction/${ref.timestamp}` : `https://hashscan.io/${topic.network}/topic/${topic.topicId}`;
const hashscanTopic = (topic) => `https://hashscan.io/${topic.network}/topic/${topic.topicId}`;

/** The full record of one version: what it claimed, how it was checked, how to re-run it. */
function nodePanel(n, tree, topic) {
  const { nodes, policy, bench } = tree;
  const p = n.detail.proposal;
  const c = counted(n);
  const ig = ignored(n);
  const ids = new Set(nodes.map((x) => x.id));
  const root = isRoot(n, ids);
  const rerun = root ? rootRerunBp(n, nodes) : null;
  const parent = nodes.find((x) => x.id === n.parent) ?? null;
  const blocked = isBlocked(n);

  const hedera = topic && n.hedera
    ? `<a class="hs-chip" href="${hashscanRecord(topic, n.hedera)}" target="_blank" rel="noreferrer">Hedera #${n.hedera.seq} \u2197</a>`
    : topic
      ? `<a class="hs-chip hs-chip-off" href="${hashscanTopic(topic)}" target="_blank" rel="noreferrer">Not on Hedera yet</a>`
      : "";

  const blockedBlock = blocked
    ? `<div class="blocked">
              <span class="code">${n.detail.mechanical.cls === "not-scored" ? "NOT SCORED YET" : "BLOCKED BEFORE MEASURING"} \u00b7 ${esc(n.detail.mechanical.cls)}</span>
              <p>${
                n.detail.mechanical.cls === "not-scored"
                  ? "The change passed every check, but replay has no recorded answers for it. Score it live to get a real number."
                  : n.detail.mechanical.cls.startsWith("typecheck")
                    ? "The change did not compile, so the benchmark never ran. The attempt is kept as a record."
                    : "A guard refused the change, so the benchmark never ran. The attempt is kept as a record."
              }</p>
              <pre>${esc(n.detail.mechanical.evidence)}</pre>
            </div>`
    : "";

  const checks =
    n.verifications.length === 0
      ? `<p class="muted">${
          root
            ? "The first version is never checked directly. Keys re-run it when they check its children."
            : "No key has checked this version yet. The author cannot check their own work."
        }</p>`
      : `<ul class="checks">${n.verifications
          .map(
            (v) => `<li class="check ${v.counted ? "counted" : "ignored"}">
              <div class="check-top">
                <span class="check-state">${v.counted ? "COUNTED" : "IGNORED"}</span>
                <code>${esc(v.runnerLabel || `key ${v.runner.slice(0, 8)}`)}</code>
                ${topic && v.hedera ? `<a class="hs-chip" href="${hashscanRecord(topic, v.hedera)}" target="_blank" rel="noreferrer">Hedera #${v.hedera.seq} \u2197</a>` : ""}
              </div>
              <p>Parent ${esc(tasks(v.parent.medianBp, v.parent.total))} \u2192 this ${esc(tasks(v.candidate.medianBp, v.candidate.total))} \u00b7 <b>${esc(signedBp(v.deltaMedianBp))}</b> \u00b7 ${v.runs} runs each</p>
              ${!v.counted && v.ignoredWhy ? `<p class="why">${esc(v.ignoredWhy)}</p>` : ""}
            </li>`,
          )
          .join("")}</ul>`;

  return `<aside class="node-panel" aria-live="polite">
            <div class="np-head">
              <svg width="14" height="14" aria-hidden="true">${glyph(n.status, 7, 7, 5)}</svg>
              <p class="eyebrow">${esc(wordOf(n))} \u00b7 ${
                topic && n.hedera
                  ? `<a class="hs-id" href="${hashscanRecord(topic, n.hedera)}" target="_blank" rel="noreferrer">${esc(n.short)}</a>`
                  : esc(n.short)
              }</p>
              ${hedera}
            </div>

            <h2 class="np-hyp">${esc(n.hypothesis)}</h2>

            <div class="verdict v-${n.status}">
              <span class="code">${esc(n.statusCode)}</span>
              <p>${esc(n.statusReason)}</p>
            </div>

            ${blockedBlock}

            <dl class="facts">
              <div>
                <dt>Score</dt>
                <dd>${esc(tasks(blocked ? claimBp(n, nodes) : (rerun ?? n.detail.claimedMedianBp), bench.total))}
                  <small>${blocked ? "author claim \u00b7 not scored yet" : rerun !== null ? `${rerun}bp \u00b7 re-run by the keys that checked its child` : `${n.detail.claimedMedianBp}bp \u00b7 author claim`}</small>
                </dd>
              </div>
              <div>
                <dt>Checked change</dt>
                <dd>${root ? "baseline" : esc(signedBp(n.verifiedDeltaBp))}<small>${root ? "the first version has no parent" : "measured by other keys, never the author"}</small></dd>
              </div>
              <div><dt>Keys</dt><dd>${c} of ${policy.minVerifications}<small>${ig > 0 ? `${ig} ignored, reason below` : "distinct keys, counted"}</small></dd></div>
              <div><dt>Cost</dt><dd>${n.costs.tokensPerTask.toLocaleString("en")}<small>tokens per task, median</small></dd></div>
            </dl>

            <div class="np-block">
              <h3>How it could be proven wrong</h3>
              ${p.falsifiedIf ? `<p class="muted"><b>Wrong if:</b> ${esc(p.falsifiedIf)}</p>` : ""}
              <p class="tags">
                ${root ? "" : `<span>aims at ${esc(objectiveOf(n))}</span>`}
                <span>area ${esc(p.primaryArea)}</span>
                <span>idea ${esc(p.motif)}</span>
                ${n.showcase ? "" : `<span class="badge">${esc(n.mode.toUpperCase())}</span>`}
              </p>
            </div>

            ${parent ? `<p class="parent-link">Copied from <a href="#s-${esc(parent.short)}">${esc(parent.short)}</a>, then changed one idea.</p>` : ""}

            <div class="np-block">
              <h3>Checks by other keys (${n.verifications.length})</h3>
              ${checks}
            </div>

            ${fork(n)}
            ${checkIt(n, topic !== null)}
            ${n.diff.trim() ? `<details class="np-block diff"><summary>Show the change</summary><pre>${esc(n.diff)}</pre></details>` : ""}
          </aside>`;
}

/* ------------------------------------------------------------------ *
 * The info panels
 * ------------------------------------------------------------------ */

/** The content behind each chip. Static markup; the radios only choose which shows. */
function infoPanels(tree, digest) {
  const { bench, policy, stats, runsPerVerification } = tree;
  const total = bench.total;
  const head = tree.nodes.find((n) => n.id === stats.head);
  const needBp = head ? head.detail.claimedMedianBp + policy.minDeltaBp : null;

  // The digest names nodes by their position in log order: n000, n001, ...
  const idKey = [...tree.nodes]
    .sort((a, b) => a.seq - b.seq)
    .map((n, i) => `n${String(i).padStart(3, "0")} = ${n.short}`)
    .join(" \u00b7 ");

  const next =
    digest === null
      ? ""
      : `<section class="panel" data-panel="next">
          <div class="digest-panel">
            <p class="eyebrow">What the next agent reads</p>
            <h2>The tree, turned into instructions</h2>
            <p class="lede">Before an agent proposes a change, it reads this page. It shows what worked, what failed and why, and which areas nobody has tried. This is the real output of <code>petri digest</code>.</p>
            <p class="idkey">The digest numbers versions in log order: ${esc(idKey)}</p>
            <pre class="digest">${esc(digest.text)}</pre>
          </div>
        </section>`;

  const chips = [
    ...(digest === null ? [] : [{ id: "next", label: "What the next agent reads", hint: "the real digest" }]),
    { id: "goal", label: "Goal", hint: "the score to beat" },
    { id: "rules", label: "Rules", hint: "six the code enforces" },
    { id: "how", label: "How it works", hint: "problem, Darwin, loop" },
    { id: "limits", label: "Limits", hint: "what it does not prove" },
  ];

  // Labelled radios: the label carries the text, so this stays a real M3 filter
  // chip group and the arrow keys move between the five.
  const chipBar = `<div class="chips" role="radiogroup" aria-label="Tree information">
            ${chips
              .map(
                (c, i) => `<input type="radio" name="panel" id="chip-${c.id}" class="chip-input"${i === 0 ? " checked" : ""}>
            <label class="chip" for="chip-${c.id}"><span class="chip-label">${esc(c.label)}</span><span class="chip-hint">${esc(c.hint)}</span></label>`,
              )
              .join("")}
          </div>`;

  const goal = `<section class="panel" data-panel="goal">
          <div class="panel-grid">
            <div>
              <p class="eyebrow">Goal</p>
              <h2>Beat the best version by ${esc(tasks(policy.minDeltaBp, total).replace(` of ${total} tasks`, ""))} whole tasks</h2>
              <p class="lede">The tree improves one agent harness. A new version is accepted only when two other keys re-run it and its parent, and it solves at least ${policy.minDeltaBp}bp more of the same test.</p>
            </div>
            <dl class="goal-facts">
              <div><dt>Best so far</dt><dd>${head ? esc(tasks(head.detail.claimedMedianBp, total)) : "none yet"}<small>${head ? esc(`${head.short} \u00b7 ${head.detail.claimedMedianBp}bp`) : ""}</small></dd></div>
              <div><dt>To beat it</dt><dd>${needBp === null ? "\u2014" : needBp <= 10000 ? esc(tasks(needBp, total)) : "cannot be beaten"}<small>${needBp !== null && needBp > 10000 ? esc(`needs ${tasks(needBp, total)}`) : esc(`best plus ${signedBp(policy.minDeltaBp)}`)}</small></dd></div>
              <div><dt>The test</dt><dd>${total} tasks<small>${esc(bench.name)} \u00b7 unit tests only</small></dd></div>
              <div><dt>Runs</dt><dd>${runsPerVerification} each side<small>the median counts</small></dd></div>
              <div><dt>Keys</dt><dd>${policy.minVerifications} needed<small>distinct keys, never the author</small></dd></div>
              <div><dt>Record</dt><dd>${stats.total} versions<small>${stats.accepted} accepted \u00b7 ${stats.rejected} rejected \u00b7 ${stats.pending} pending</small></dd></div>
            </dl>
          </div>
        </section>`;

  const rules = `<section class="panel" data-panel="rules">
          <p class="eyebrow">Rules</p>
          <h2>Six rules the code enforces</h2>
          <ol class="rules">
            <li><b>An author cannot verify their own version.</b> Petri refuses the key. It needs ${policy.minVerifications} distinct keys, and two reports from one key count as one.</li>
            <li><b>Every candidate runs ${runsPerVerification} times.</b> The median decides. An even number of runs is refused.</li>
            <li><b>Rejected versions are never deleted.</b> A failure tells the next agent where not to go.</li>
            <li><b>Every version states what its author expected.</b> A diff alone does not say why.</li>
            <li><b>The score is pass or fail on unit tests.</b> No model grades the answer, so nobody argues about the number.</li>
            <li><b>Reading and verifying the shipped tree needs no API key and no Hedera account.</b></li>
          </ol>
        </section>`;

  const how = `<section class="panel" data-panel="how">
          <div class="how">
            <div>
              <p class="eyebrow">The problem</p>
              <h2>Nobody knows what makes an AI agent better</h2>
              <div class="faults">
                <div><h3>Nobody measures</h3><p>People copy harness tricks from blog posts. They rarely test them on their own agent.</p></div>
                <div><h3>Failures stay private</h3><p>A failed idea dies on one laptop. The next team pays the same tokens to learn the same thing.</p></div>
                <div><h3>Nobody can check a claim</h3><p>A score measured on your own computer proves nothing to anyone else.</p></div>
              </div>
            </div>
            <div>
              <p class="eyebrow">The mechanism</p>
              <h2>Darwin's three conditions, on code</h2>
              <table>
                <thead><tr><th scope="col">Condition</th><th scope="col">In nature</th><th scope="col">In Petri</th></tr></thead>
                <tbody>
                  <tr><td>Variation</td><td>Animals differ from each other</td><td>Children of one version try different ideas</td></tr>
                  <tr><td>Inheritance</td><td>A child keeps most of its parent</td><td>A child copies its parent harness, then changes at most 2 files</td></tr>
                  <tr><td>Selection</td><td>The fit survive</td><td>Accepted only if two other keys measure it ${policy.minDeltaBp}bp better</td></tr>
                </tbody>
              </table>
              <p class="punch">Nature throws failures away, so every species learns the same lesson again. Petri keeps them, with the sentence that explains why they failed.</p>
            </div>
            <div>
              <p class="eyebrow">The loop</p>
              <h2>How the tree grows</h2>
              <ol class="loop">
                <li><b>An agent reads the digest.</b> It sees what worked, what failed and why, and what nobody tried.</li>
                <li><b>It proposes one change.</b> It states what it expects, and what result would prove it wrong.</li>
                <li><b>It measures the change.</b> ${total} tasks, ${runsPerVerification} runs.</li>
                <li><b>Two other keys verify it.</b> Each re-runs the parent and the child, then signs both scores.</li>
                <li><b>The tree records the verdict.</b> Accepted or rejected, the version stays.</li>
                <li><b>The next agent reads a bigger tree.</b></li>
              </ol>
            </div>
          </div>
        </section>`;

  const limits = `<section class="panel" data-panel="limits">
          <p class="eyebrow">Honest limits</p>
          <h2>What this does not prove</h2>
          <ul class="limits">
            <li><b>A lazy verifier can sign without running the test.</b> Petri cannot catch this yet. It needs an evidence and dispute process.</li>
            <li><b>Two distinct keys are not two distinct people.</b> On a local log, one person can hold every key.</li>
            <li><b>Hedera gives shared order and a timestamp.</b> It does not prove a verifier ran the benchmark.</li>
            <li><b>The test is ${total} small coding tasks.</b> A gain here may not help your own agent.</li>
            <li><b>One shared test invites people to fit it.</b> Repeat runs and a wide margin slow this down. They do not stop it.</li>
          </ul>
        </section>`;

  return `<div class="panels">${chipBar}${next}${goal}${rules}${how}${limits}</div>`;
}

/* ------------------------------------------------------------------ *
 * The stats view
 * ------------------------------------------------------------------ */

const CHART = { W: 900, H: 340, L: 70, RIGHT: 860, T: 46, B: 280 };

/** The score a node was measured at by other keys. Falls back to the author claim. */
function scoreBpOf(n, nodes, ids) {
  if (isBlocked(n)) return claimBp(n, nodes);
  if (isRoot(n, ids)) return rootRerunBp(n, nodes) ?? n.detail.claimedMedianBp;
  return n.verifications.find((v) => v.counted)?.candidate.medianBp ?? n.detail.claimedMedianBp;
}

function statsView(tree) {
  const { W, H, L, RIGHT, T, B } = CHART;
  const { nodes, policy, stats, bench } = tree;
  const total = bench.total;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());

  const depthOf = (n) => {
    let depth = 0;
    let cur = n;
    const seen = new Set();
    while (cur && !isRoot(cur, ids) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent);
      depth++;
    }
    return depth;
  };

  const all = nodes.map((n) => ({ n, d: depthOf(n), t: tasksOf(scoreBpOf(n, nodes, ids), total) }));
  // Like an eval chart, plot only versions that were measured. A blocked one has no score.
  const pts = all.filter((p) => !isBlocked(p.n));
  const unscored = all.length - pts.length;

  // The accepted spine: the best version and every ancestor back to the start.
  const spine = [];
  let cur = byId.get(stats.head);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const p = pts.find((x) => x.n.id === cur.id);
    if (p) spine.unshift(p);
    cur = isRoot(cur, ids) ? undefined : byId.get(cur.parent);
  }
  const onSpine = new Set(spine.map((p) => p.n.id));
  const others = pts.filter((p) => !onSpine.has(p.n.id));

  const head = spine.at(-1) ?? null;
  const needBp = head ? head.n.detail.claimedMedianBp + policy.minDeltaBp : null;
  const beatable = needBp !== null && needBp <= 10000;
  const needTasks = needBp === null ? null : tasksOf(needBp, total);
  const goalTasks = needTasks === null ? null : beatable ? needTasks : total;

  // The axis stops at the deepest plotted version, so it is never wider than the
  // data it describes. (The reference adds one empty round beyond the data.)
  const rounds = Math.max(2, Math.max(0, ...pts.map((p) => p.d)));
  const x = (depth) => L + (depth / rounds) * (RIGHT - L);
  const y = (t) => B - (t / total) * (B - T);
  const ticks = [0, 1, 2, 3, 4].map((i) => Math.round((i * total) / 4));

  // Failed tries sit just right of their round, fanned out, so they never hide a spine marker.
  const shift = new Map();
  const perRound = new Map();
  for (const p of others) {
    const i = perRound.get(p.d) ?? 0;
    shift.set(p.n.id, 20 + i * 18);
    perRound.set(p.d, i + 1);
  }

  const gridLines = ticks
    .map(
      (t) => `<line class="${t === 0 ? "c-axis" : "c-grid"}" x1="${L}" x2="${RIGHT}" y1="${r1(y(t))}" y2="${r1(y(t))}"/>
            <text class="c-tick" x="${L - 12}" y="${r1(y(t) + 4)}" text-anchor="end">${t}/${total}</text>`,
    )
    .join("");

  const roundLabels = Array.from({ length: rounds + 1 }, (_, r) =>
    `<text class="c-tick" x="${r1(x(r))}" y="${B + 24}" text-anchor="middle">${r === 0 ? "start" : `round ${r}`}</text>`,
  ).join("");

  const goalLine =
    head && goalTasks !== null
      ? `<line class="c-bar" x1="${L}" x2="${RIGHT}" y1="${r1(y(goalTasks))}" y2="${r1(y(goalTasks))}"/>
            <text class="c-note c-goal" x="${RIGHT}" y="${r1(y(goalTasks) - 9)}" text-anchor="end">goal \u00b7 ${goalTasks}/${total} tasks</text>`
      : "";

  const otherDots = others
    .map((p) => {
      const cls = p.n.status === "accepted" ? "c-pass c-offspine" : p.n.status === "rejected" ? "c-fail" : "c-wait";
      return `<circle class="${cls}" cx="${r1(x(p.d) + (shift.get(p.n.id) ?? 0))}" cy="${r1(y(p.t))}" r="6.5"><title>${esc(`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`)}</title></circle>`;
    })
    .join("");

  const climbs = pts
    .filter((p) => p.n.status === "accepted" && !onSpine.has(p.n.id))
    .map((p) => {
      const parent = pts.find((q) => q.n.id === p.n.parent);
      if (!parent) return "";
      const px = x(parent.d) + (shift.get(parent.n.id) ?? 0);
      return `<line class="c-line c-climb" x1="${r1(px)}" y1="${r1(y(parent.t))}" x2="${r1(x(p.d) + (shift.get(p.n.id) ?? 0))}" y2="${r1(y(p.t))}"/>`;
    })
    .join("");

  const spineLine =
    spine.length > 1 ? `<path class="c-line" d="${spine.map((p, i) => `${i === 0 ? "M" : "L"}${r1(x(p.d))} ${r1(y(p.t))}`).join(" ")}"/>` : "";

  const spineDots = spine
    .map((p) => `<circle class="c-pass" cx="${r1(x(p.d))}" cy="${r1(y(p.t))}" r="7"><title>${esc(`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`)}</title></circle>`)
    .join("");

  const headLabel = head ? `<text class="c-val" x="${r1(x(head.d))}" y="${r1(y(head.t) - 15)}" text-anchor="middle">${head.t}/${total}</text>` : "";

  const pendingLegend = others.some((p) => p.n.status !== "accepted" && p.n.status !== "rejected")
    ? `<span><svg width="16" height="16" aria-hidden="true"><circle class="c-wait" cx="8" cy="8" r="5.5"/></svg>Pending</span>`
    : "";

  const tableRows = all
    .map(
      (p) => `<tr><td><code>${esc(p.n.short)}</code></td><td>${p.d === 0 ? "start" : p.d}</td><td>${esc(STATUS_WORD[p.n.status])}</td><td>${isBlocked(p.n) ? "not scored" : `${p.t}/${total} tasks`}</td></tr>`,
    )
    .join("");

  return `<section class="stats" aria-labelledby="stats-title">
          <div class="stats-head">
            <h2 id="stats-title">Stats</h2>
            <p class="muted">Most tries fail. The best score only moves up.</p>
          </div>

          <dl class="goalstrip">
            <div><dt>Best so far</dt><dd>${head ? esc(tasks(head.n.detail.claimedMedianBp, total)) : "none yet"}<small>${head ? esc(`${head.n.short} \u00b7 ${head.n.detail.claimedMedianBp}bp`) : "no accepted version"}</small></dd></div>
            <div>
              <dt>Goal</dt>
              <dd>${goalTasks === null ? "\u2014" : esc(tasks((goalTasks * 10000) / total, total))}</dd>
              <small class="dd-note">${
                beatable || needTasks === null
                  ? esc(`${signedBp(policy.minDeltaBp)} over the best, checked by ${policy.minVerifications} other keys`)
                  : esc(`the full benchmark \u00b7 a win over ${head.n.short} needs ${needTasks} of ${total}`)
              }</small>
            </div>
            <div><dt>Recorded</dt><dd>${stats.total} versions<small>${stats.accepted} accepted \u00b7 ${stats.rejected} rejected and kept \u00b7 ${stats.pending} pending</small></dd></div>
          </dl>

          <figure class="chart-figure">
            <div class="plate chart-plate">
              <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-cap">
                ${gridLines}${roundLabels}${goalLine}${otherDots}${climbs}${spineLine}${spineDots}${headLabel}
              </svg>
            </div>
            <div class="legend">
              <span><svg width="34" height="14" aria-hidden="true"><line class="c-line" x1="2" x2="32" y1="7" y2="7"/><circle class="c-pass" cx="17" cy="7" r="5"/></svg>Accepted, and became the new parent</span>
              <span><svg width="16" height="16" aria-hidden="true"><circle class="c-fail" cx="8" cy="8" r="5.5"/></svg>Rejected, and kept in the tree</span>
              ${pendingLegend}
            </div>
            <figcaption id="chart-cap">
              Each round is one generation deeper in the tree. Scores are medians re-run by other keys, from the real tree.
              A version passes only if it beats its parent by ${esc(signedBp(policy.minDeltaBp))}.
              ${unscored > 0 ? ` ${unscored} ${unscored === 1 ? "version was" : "versions were"} stopped before scoring and ${unscored === 1 ? "is" : "are"} not plotted. See the table.` : ""}
            </figcaption>
            <details class="table-view">
              <summary>Show as a table</summary>
              <table>
                <thead><tr><th scope="col">Version</th><th scope="col">Round</th><th scope="col">Status</th><th scope="col">Score</th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>
            </details>
          </figure>
        </section>`;
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

/**
 * The document head. `pageCss` is the per-tree stylesheet — every page links the
 * shared `styles.css`, and a tree page additionally links its own generated one.
 * Passing `null` (the gallery) leaves the extra link out entirely.
 */
const HEAD = (title, description, pageCss = null) => `<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="styles.css" />${
      pageCss === null
        ? ""
        : `
    <!-- This tree's own selection rules. Only the page knows its node ids, so
         build.mjs generates them; nothing here is hand-written. -->
    <link rel="stylesheet" href="${esc(pageCss)}" />`
    }
    <!-- Deferred so it never blocks the first paint. Every page is complete
         without it; the script only adds polish. -->
    <script src="main.js" defer></script>`;

/** The site chrome. Both pages carry it, so the header offset matches the reference. */
const TOPBAR = `<header class="topbar">
      <div class="topbar-in">
        <a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true"></span>Petri</a>
        <nav class="topnav" aria-label="Main">
          <a href="index.html">Trees</a>
          <a href="https://github.com/Avoisavo/ethonline2026">GitHub</a>
        </nav>
      </div>
    </header>`;

/**
 * The page shell. Every page is written into one folder, so the stylesheet, the
 * script and the links between pages are all plain siblings — which keeps the
 * site working whether it is opened from disk or served from a sub-path.
 */
const shell = (title, description, body, wide = false, pageCss = null) => `<!doctype html>
<html lang="en">
  <head>
${HEAD(title, description, pageCss)}
  </head>
  <body>
    ${TOPBAR}
    <main class="container${wide ? " container-wide" : ""}">
${body}
    </main>
  </body>
</html>
`;

function galleryPage() {
  const cards = TREES.map((entry) => galleryCard(entry, loadTree(entry).tree)).join("");
  const domains = new Set(TREES.map((t) => t.domain)).size;

  const body = `      <section class="section" aria-labelledby="trees-heading">
        <div class="section-head">
          <h1 id="trees-heading">Trees</h1>
          <p class="muted">${TREES.length} trees across ${domains} domains</p>
        </div>
        <ul class="cards">${cards}
        </ul>
      </section>`;

  return shell("Trees \u00b7 Petri", "A gallery of agent-harness trees. Every version is re-checked, and failures are kept.", body);
}

/**
 * Per-page rules that let the chosen version drive the figure. Only the page
 * knows its own node ids, so the rules are generated.
 *
 * A version can be chosen two ways, and the rules cover both without them ever
 * fighting. With no script, the figure links to a version's record id, so
 * `:target` does the work. With a script, `main.js` marks the strip `is-open`
 * instead — because `:target` is not re-evaluated when the fragment is rewritten
 * in place. The `:target` half switches itself off the moment a strip is marked,
 * so the two can never show two records at once.
 *
 * The rules set custom properties rather than declarations, so one rule covers
 * the wide figure and the narrow list together, and another covers the strip and
 * its record. The shared stylesheet supplies the defaults (`--sel-ring` falls
 * back to `none`), so an unchosen version costs nothing.
 *
 * This is emitted as its own stylesheet, `<slug>.css`, rather than an inline
 * `<style>` block: it keeps the HTML free of generated CSS, and it means one
 * tree's rules can be read, cached and edited without touching another's.
 */
function selectionCss(nodes, head) {
  const SELECTED = [
    "--sel-ring: block",
    "--sel-hit: var(--md-sys-color-primary-container)",
    "--sel-edge: var(--md-sys-color-primary)",
    "--sel-backdrop: var(--md-sys-color-primary-container)",
    "--sel-row: var(--md-sys-color-primary-container)",
  ].join("; ");

  /** Either way a version can be chosen: by the fragment, or by the script. */
  const chosen = (id) => `:is(body:not(:has(.selected-strip.is-open)):has(#s-${id}:target), body:has(.selected-strip.is-open):has(.selected-strip[data-for="${id}"].is-open))`;

  const perNode = nodes
    .map((n) => {
      const id = esc(n.short);
      return `${chosen(id)} :is(.selected-strip[data-for="${id}"], .rec[data-for="${id}"]) { --sel-strip: flex; --sel-rec: block; }
${chosen(id)} :is(.h-node[href="#s-${id}"], .t-row[href="#s-${id}"]) { ${SELECTED}; }`;
    })
    .join("\n\n");

  const first = esc(head.short);
  // No version chosen yet: nothing is targeted and no strip is marked. Note the
  // `:target` test is on `.rec`, because that is what carries the `s-*` id; a
  // stray fragment such as `#record` matches no record, so this stays true and
  // the default version is correctly shown.
  const none = "body:not(:has(.rec:target)):not(:has(.selected-strip.is-open))";

  return `/* Selection rules for one tree — GENERATED by build.mjs. Do not edit by hand;
   edit \`selectionCss()\` in build.mjs and re-run \`node build.mjs\`.

   Which version is on show, and how a chosen node is drawn. The shared
   stylesheet owns everything else, including the default values these override.

   Two ways in, one outcome:
     - no script  → the figure links to #s-<short>, so :target decides
     - with script → main.js marks the strip .is-open, because :target is not
                     re-evaluated when the fragment is rewritten in place
   The :target half is disabled the moment a strip is marked, so the two can
   never show two records at once.
*/

/* Until a version is chosen, the best one is the one on show. */
${none} :is(.selected-strip[data-default], .rec[data-default]) { --sel-strip: flex; --sel-rec: block; }
${none} :is(.h-node[href="#s-${first}"], .t-row[href="#s-${first}"]) { ${SELECTED}; }

${perNode}
`;
}

function treePage(entry, tree, digest) {
  const topic = tree.hedera ?? null;
  const head = tree.nodes.find((n) => n.id === tree.stats.head) ?? tree.nodes[0];
  const isHead = (n) => (n.id === tree.stats.head ? " data-default" : "");

  // The reference puts the strip inside the figure and the records in a
  // separate section, so the two gaps are the figure's own (10px) and the
  // container's (24px). This mirrors that.
  const strips = tree.nodes.map((n) => selectedStrip(n, tree)).join("\n          ");
  // The `s-<short>` id lives here, on the record, not on the strip: that is what
  // makes one fragment both choose the version and scroll to it. See the note on
  // `selectedStrip`.
  const records = tree.nodes
    .map((n) => `<article class="rec" id="s-${esc(n.short)}" data-for="${esc(n.short)}"${isHead(n)}>${nodePanel(n, tree, topic)}</article>`)
    .join("\n          ");

  const body = `      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="index.html">Trees</a><span aria-hidden="true">/</span><span>${esc(entry.domain)}</span><span aria-hidden="true">/</span><span>${esc(entry.harness)} \u00d7 ${esc(entry.model)}</span>
      </nav>

      <div class="page-head">
        <div>
          <h1>${esc(entry.harness)} <span class="h1-sub">\u00d7 ${esc(entry.model)} (${esc(entry.domain)})</span></h1>
        </div>
      </div>

      <div class="view-bar">
        <div class="seg" role="group" aria-label="View">
          <input type="radio" name="view" id="view-tree" class="seg-input" checked>
          <label for="view-tree">Tree</label>
          <input type="radio" name="view" id="view-stats" class="seg-input">
          <label for="view-stats">Stats</label>
        </div>
      </div>

      <div class="view view-tree">
        <figure class="stage">
          <div class="plate tree-plate" tabindex="0" role="region" aria-label="Lineage figure of ${tree.nodes.length} versions. Scroll sideways to see the whole tree.">
            <div class="legend legend-overlay" aria-label="Legend">
              <span><svg width="14" height="14" aria-hidden="true">${glyph("accepted", 7, 7, 5)}</svg>Accepted \u2014 two other keys re-ran it and agreed</span>
              <span><svg width="14" height="14" aria-hidden="true">${glyph("rejected", 7, 7, 5)}</svg>Rejected \u2014 kept, with the reason</span>
              <span><svg width="14" height="14" aria-hidden="true">${glyph("pending", 7, 7, 5)}</svg>Pending \u2014 waiting for keys</span>
              <span><svg width="22" height="14" aria-hidden="true"><line class="h-edge restore" x1="1" x2="21" y1="7" y2="7"/></svg>Runs the same harness as that version again</span>
            </div>
            ${heroTree(tree, tree.bench)}
            ${treeList(tree, tree.bench)}
          </div>
          ${strips}
        </figure>

        <section class="record" id="record">
          ${records}

          <div class="record-info">${infoPanels(tree, digest)}</div>
        </section>
      </div>

      <div class="view view-stats">
        ${statsView(tree)}
      </div>`;

  // Returns the page and its stylesheet together, so the two are always written
  // as a matched pair and the `<link>` can never point at a stale filename.
  const html = shell(
    `${entry.harness} \u00d7 ${entry.model} \u00b7 Petri`,
    `${entry.goal}. Every version is re-checked by other keys, and failures are kept.`,
    body,
    true,
    `${entry.slug}.css`,
  );
  return { html, css: selectionCss(tree.nodes, head) };
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

const built = TREES.map((entry) => ({ entry, ...loadTree(entry) }));

await writeFile(join(HERE, "index.html"), galleryPage(), "utf8");

let pageBytes = 0;
let cssBytes = 0;
for (const { entry, tree, digest } of built) {
  const { html, css } = treePage(entry, tree, digest);
  pageBytes += html.length;
  cssBytes += css.length;
  await writeFile(join(HERE, `${entry.slug}.html`), html, "utf8");
  await writeFile(join(HERE, `${entry.slug}.css`), css, "utf8");
}

const kb = (n) => Math.round(n / 1024);
console.log(
  `Wrote index.html, ${built.length} tree pages (${kb(pageBytes)}KB) ` +
    `and ${built.length} tree stylesheets (${kb(cssBytes)}KB).`,
);
