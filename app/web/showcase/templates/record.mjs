import { glyph } from "../lib/glyph.mjs";
import { OBJECTIVES } from "../lib/objectives.mjs";
import {
	claimBp,
	counted,
	ignored,
	isBlocked,
	isRoot,
	objectiveOf,
	rootRerunBp,
	signedBp,
	tasks,
	wordOf,
} from "../lib/format.mjs";
import { esc, hashscanRecord, hashscanTopic } from "./shared.mjs";

// Both faces ship as markup; CSS picks the success state without rebuilding the DOM.
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

// The browser fills these placeholders, rather than carrying its own command wording.
const forkTemplate = (short, area) =>
	`pnpm petri propose --parent ${short} --area ${area} --motif {{motif}} \\\n  --hypothesis "This change improves {{direction}}, because ..."`;
const fillFork = (template, direction) =>
	template
		.replaceAll("{{motif}}", direction.replace(/\s+/g, "-"))
		.replaceAll("{{direction}}", direction);

function fork(n) {
	const template = forkTemplate(n.short, n.detail.proposal.primaryArea);
	const options = OBJECTIVES.map(
		(o, i) =>
			`<option value="${esc(o)}"${i === 0 ? " selected" : ""}>${esc(o)}</option>`,
	).join("");
	// data-fork-out stays on the pre: rewriting its text must not remove the sibling button.
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
	{
		what: "How it works",
		why: "The record every agent reads before it proposes a change: what won, what failed, and why.",
		cmds: ["pnpm petri digest"],
	},
	{
		what: "Run it",
		why: scored
			? "The harness reads a task, the model writes the code, the tests run in the sandbox. 3 tasks by default, and nothing is signed."
			: "This version has no recorded answers, so it runs only against a real model. It needs ANTHROPIC_API_KEY.",
		cmds: [
			scored
				? `pnpm petri run ${short}`
				: `ANTHROPIC_API_KEY=... pnpm petri run ${short} --mode live`,
		],
	},
	{
		what: "Evals",
		why: scored
			? "The whole benchmark, 5 times: every task passed or failed, and the median score."
			: "The whole benchmark, 5 times, against a real model. Replay cannot score this version.",
		cmds: [
			scored
				? `pnpm petri evals ${short}`
				: `ANTHROPIC_API_KEY=... pnpm petri evals ${short} --mode live`,
		],
	},
	{
		what: "Verify it",
		why: scored
			? "Your key re-runs this version and its parent, then signs the result. The author's own key is refused."
			: "A version with no score cannot be verified. Score it live first, then another key signs it.",
		cmds: [
			"PETRI_HOME=~/my-verifier pnpm petri id create --label me",
			`PETRI_HOME=~/my-verifier pnpm petri verify ${short} --show`,
		],
	},
	{
		what: "Check the record",
		why: hasTopic
			? "Every signature and the hash chain, then the public Hedera copy compared byte for byte."
			: "Every signature and the hash chain of the log.",
		cmds: hasTopic
			? ["pnpm petri fsck", "pnpm petri hedera check"]
			: ["pnpm petri fsck"],
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
	const keyNote = scored
		? "Nothing here needs an API key."
		: "Reading and checking the record needs no API key; running or scoring this version live needs ANTHROPIC_API_KEY.";
	return `<div class="np-block checkit">
            <h3>Check it yourself</h3>
            <p class="muted">Clone the repo, then run these from the repository root. ${keyNote}</p>
            <ol class="checkit-steps">${steps}</ol>
          </div>`;
}

/** The full record: the claim, checks, and commands to re-run one version. */
export function nodePanel(n, tree, topic) {
	const { nodes, policy, bench } = tree;
	const p = n.detail.proposal;
	const c = counted(n);
	const ig = ignored(n);
	const ids = new Set(nodes.map((x) => x.id));
	const root = isRoot(n, ids);
	const rerun = root ? rootRerunBp(n, nodes) : null;
	const parent = nodes.find((x) => x.id === n.parent) ?? null;
	const blocked = isBlocked(n);

	const hedera =
		topic && n.hedera
			? `<a class="hs-chip" href="${esc(hashscanRecord(topic, n.hedera))}" target="_blank" rel="noreferrer">Hedera #${esc(n.hedera.seq)} \u2197</a>`
			: topic
				? `<a class="hs-chip hs-chip-off" href="${esc(hashscanTopic(topic))}" target="_blank" rel="noreferrer">Not on Hedera yet</a>`
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
                ${topic && v.hedera ? `<a class="hs-chip" href="${esc(hashscanRecord(topic, v.hedera))}" target="_blank" rel="noreferrer">Hedera #${esc(v.hedera.seq)} \u2197</a>` : ""}
              </div>
              <p>Parent ${esc(tasks(v.parent.medianBp, v.parent.total))} \u2192 this ${esc(tasks(v.candidate.medianBp, v.candidate.total))} \u00b7 <b>${esc(signedBp(v.deltaMedianBp))}</b> \u00b7 ${esc(v.runs)} runs each</p>
              ${!v.counted && v.ignoredWhy ? `<p class="why">${esc(v.ignoredWhy)}</p>` : ""}
            </li>`,
					)
					.join("")}</ul>`;

	return `<div class="node-panel" aria-live="polite">
            <div class="np-head">
              <svg width="14" height="14" aria-hidden="true">${glyph(n.status, 7, 7, 5)}</svg>
              <p class="eyebrow">${esc(wordOf(n))} \u00b7 ${
								topic && n.hedera
									? `<a class="hs-id" href="${esc(hashscanRecord(topic, n.hedera))}" target="_blank" rel="noreferrer">${esc(n.short)}</a>`
									: esc(n.short)
							}</p>
              ${hedera}
            </div>

            <h2 class="np-hyp">${esc(n.hypothesis)}</h2>

            <div class="verdict v-${esc(n.status)}">
              <span class="code">${esc(n.statusCode)}</span>
              <p>${esc(n.statusReason)}</p>
            </div>

            ${blockedBlock}

            <dl class="facts">
              <div>
                <dt>Score</dt>
                <dd>${esc(tasks(blocked ? claimBp(n, nodes) : (rerun ?? n.detail.claimedMedianBp), bench.total))}
                  <small>${blocked ? "author claim \u00b7 not scored yet" : rerun !== null ? esc(`${rerun}bp \u00b7 re-run by the keys that checked its child`) : esc(`${n.detail.claimedMedianBp}bp \u00b7 author claim`)}</small>
                </dd>
              </div>
              <div>
                <dt>Checked change</dt>
                <dd>${root ? "baseline" : esc(signedBp(n.verifiedDeltaBp))}<small>${root ? "the first version has no parent" : "measured by other keys, never the author"}</small></dd>
              </div>
              <div><dt>Keys</dt><dd>${esc(c)} of ${esc(policy.minVerifications)}<small>${ig > 0 ? esc(`${ig} ignored, reason below`) : "distinct keys, counted"}</small></dd></div>
              <div><dt>Cost</dt><dd>${esc(n.costs.tokensPerTask.toLocaleString("en"))}<small>tokens per task, median</small></dd></div>
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
              <h3>Checks by other keys (${esc(n.verifications.length)})</h3>
              ${checks}
            </div>

            ${fork(n)}
            ${checkIt(n, topic !== null)}
            ${n.diff.trim() ? `<details class="np-block diff"><summary>Show the change</summary><pre>${esc(n.diff)}</pre></details>` : ""}
          </div>`;
}
