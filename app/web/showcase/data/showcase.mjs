/**
 * Showcase trees — a port of the reference `lib/showcase.ts`.
 *
 * Five of the six trees in the gallery are hand-authored. Each node states the
 * score it reached, and the builder derives its status with the same acceptance
 * rule the engine uses (+1000bp passes, -1000bp or worse is a regression,
 * anything between is a tie). Deriving rather than hand-labelling is what keeps
 * every showcase tree internally consistent.
 *
 * The sixth tree (the Petri harness) is read from a real `petri export` instead;
 * see `registry.mjs`.
 */

import { validateShowcaseTree } from "../lib/validation.mjs";

/** Acceptance margin in basis points, from the engine's policy. */
export const MARGIN = 1000;
const KEYS = ["A", "B"];

/** A showcase node. `tasks` is the score it reached; `tokens` feeds the cost fact. */
const n = (
	id,
	parent,
	kind,
	hyp,
	area,
	objective,
	tasks,
	tokens = 4000,
	cls,
	evidence,
) => ({
	id,
	parent,
	kind,
	hyp,
	area,
	objective,
	tasks,
	tokens,
	cls,
	evidence,
});

export const SHOWCASE_TREES = {
	hermes: {
		key: "hermes",
		benchName: "research tasks",
		total: 40,
		model: "claude-sonnet-5",
		nodes: [
			n(
				"he-00",
				null,
				"root",
				"Hermes Agent, default settings",
				"other",
				"",
				18,
				3900,
			),
			n(
				"he-01",
				"he-00",
				"measured",
				"retry a failed tool call once",
				"recovery",
				"accuracy",
				23,
				4300,
			),
			n(
				"he-02",
				"he-00",
				"measured",
				"cache tool results per session",
				"memory",
				"token savings",
				22,
				3100,
			),
			n(
				"he-03",
				"he-00",
				"measured",
				"a shorter system prompt",
				"prompt",
				"token savings",
				17,
				3300,
			),
			n(
				"he-05",
				"he-01",
				"measured",
				"read the error before retrying",
				"recovery",
				"accuracy",
				28,
				4600,
			),
			n(
				"he-06",
				"he-01",
				"measured",
				"retry up to five times",
				"recovery",
				"accuracy",
				22,
				6200,
			),
			n(
				"he-07",
				"he-01",
				"measured",
				"load every skill at start",
				"retrieval",
				"accuracy",
				18,
				9800,
			),
			n(
				"he-12",
				"he-02",
				"measured",
				"cache per task, not per session",
				"memory",
				"token savings",
				27,
				2900,
			),
			n(
				"he-04",
				"he-02",
				"pending",
				"clear the cache on file edit",
				"memory",
				"accuracy",
				30,
				3200,
			),
			n(
				"he-08",
				"he-05",
				"measured",
				"compress old turns at 80%",
				"memory",
				"speed",
				33,
				4100,
			),
			n(
				"he-09",
				"he-05",
				"measured",
				"summarise every tool output",
				"memory",
				"token savings",
				26,
				3500,
			),
			n(
				"he-10",
				"he-08",
				"pending",
				"send hard tasks to a sub-agent",
				"decomposition",
				"accuracy",
				38,
				7400,
			),
			n(
				"he-11",
				"he-08",
				"measured",
				"plan every step first",
				"loop",
				"trust",
				31,
				6900,
			),
		],
	},

	claudeCode: {
		key: "claudeCode",
		benchName: "coding tasks",
		total: 40,
		model: "claude-opus-5",
		nodes: [
			n(
				"cc-00",
				null,
				"root",
				"Claude Code, default settings",
				"other",
				"",
				22,
				5200,
			),
			n(
				"cc-01",
				"cc-00",
				"measured",
				"run the tests before finishing",
				"verification",
				"accuracy",
				27,
				6100,
			),
			n(
				"cc-02",
				"cc-00",
				"measured",
				"skip reading the repo map",
				"retrieval",
				"speed",
				26,
				3900,
			),
			n(
				"cc-03",
				"cc-00",
				"blocked",
				"run the shell as root",
				"other",
				"speed",
				0,
				0,
				"sandbox-violation",
				"harness/tools.ts: spawns a privileged shell. Tools may not raise their own permissions.",
			),
			n(
				"cc-04",
				"cc-01",
				"measured",
				"fix one failing test at a time",
				"recovery",
				"accuracy",
				32,
				6400,
			),
			n(
				"cc-05",
				"cc-01",
				"measured",
				"cap tool calls at ten",
				"budget",
				"token savings",
				25,
				4200,
			),
			n(
				"cc-06",
				"cc-01",
				"measured",
				"never edit outside the repo",
				"other",
				"security",
				23,
				6000,
			),
			n(
				"cc-11",
				"cc-02",
				"measured",
				"read only files the task names",
				"retrieval",
				"speed",
				31,
				3500,
			),
			n(
				"cc-12",
				"cc-02",
				"measured",
				"skip running the linters",
				"loop",
				"speed",
				24,
				3300,
			),
			n(
				"cc-07",
				"cc-04",
				"measured",
				"review its own diff for secrets",
				"verification",
				"security",
				36,
				6900,
			),
			n(
				"cc-08",
				"cc-04",
				"pending",
				"plan the change before editing",
				"decomposition",
				"code quality",
				38,
				7300,
			),
			n(
				"cc-09",
				"cc-04",
				"measured",
				"write shorter commit messages",
				"prompt",
				"speed",
				30,
				6000,
			),
			n(
				"cc-10",
				"cc-07",
				"blocked",
				"read the .env file for context",
				"retrieval",
				"accuracy",
				0,
				0,
				"sandbox-violation",
				"harness/retrieval.ts: reads .env. The harness may not read secrets or test files.",
			),
		],
	},

	pi: {
		key: "pi",
		benchName: "finance analysis tasks",
		total: 20,
		model: "claude-haiku-4-5",
		nodes: [
			n("pi-00", null, "root", "Pi, default settings", "other", "", 8, 1800),
			n(
				"pi-01",
				"pi-00",
				"measured",
				"cite the filing for every number",
				"prompt",
				"trust",
				11,
				2300,
			),
			n(
				"pi-10",
				"pi-00",
				"measured",
				"extract tables before the text",
				"retrieval",
				"token savings",
				11,
				1500,
			),
			n(
				"pi-02",
				"pi-00",
				"measured",
				"answer without a calculator",
				"budget",
				"token savings",
				7,
				1500,
			),
			n(
				"pi-03",
				"pi-00",
				"measured",
				"guess the missing figures",
				"other",
				"speed",
				5,
				1400,
			),
			n(
				"pi-04",
				"pi-01",
				"measured",
				"use a calculator for all maths",
				"loop",
				"accuracy",
				14,
				2600,
			),
			n(
				"pi-05",
				"pi-01",
				"pending",
				"flag advice that needs an adviser",
				"other",
				"ethics",
				11,
				2400,
			),
			n(
				"pi-11",
				"pi-10",
				"measured",
				"keep only the income statement",
				"retrieval",
				"token savings",
				10,
				1200,
			),
			n(
				"pi-06",
				"pi-04",
				"blocked",
				"fetch live prices from the web",
				"retrieval",
				"accuracy",
				0,
				0,
				"sandbox-violation",
				"harness/tools.ts: opens a network socket. The harness may not call the network during the benchmark.",
			),
			n(
				"pi-07",
				"pi-04",
				"measured",
				"check totals against the balance sheet",
				"verification",
				"accuracy",
				16,
				2900,
			),
			n(
				"pi-08",
				"pi-04",
				"measured",
				"summarise the filing first",
				"decomposition",
				"token savings",
				13,
				2200,
			),
			n(
				"pi-09",
				"pi-07",
				"pending",
				"show every calculation step",
				"prompt",
				"trust",
				18,
				3300,
			),
		],
	},

	codex: {
		key: "codex",
		benchName: "planted vulnerabilities",
		total: 40,
		model: "gpt-5",
		nodes: [
			n(
				"cx-00",
				null,
				"root",
				"Codex CLI, default settings",
				"other",
				"",
				14,
				4800,
			),
			n(
				"cx-01",
				"cx-00",
				"measured",
				"read the whole call path first",
				"retrieval",
				"accuracy",
				19,
				6200,
			),
			n(
				"cx-02",
				"cx-00",
				"measured",
				"scan only the changed files",
				"retrieval",
				"speed",
				18,
				2900,
			),
			n(
				"cx-03",
				"cx-00",
				"blocked",
				"run the exploit to confirm it",
				"verification",
				"accuracy",
				0,
				0,
				"sandbox-violation",
				"harness/verify.ts: executes code from the task. The harness may not run untrusted code.",
			),
			n(
				"cx-04",
				"cx-01",
				"measured",
				"check every input for taint",
				"verification",
				"security",
				24,
				6800,
			),
			n(
				"cx-05",
				"cx-01",
				"measured",
				"report every warning as a bug",
				"prompt",
				"accuracy",
				15,
				6300,
			),
			n(
				"cx-06",
				"cx-01",
				"blocked",
				"rank findings by severity",
				"loop",
				"code quality",
				0,
				0,
				"typecheck-failed",
				"harness/loop.ts(52,14): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Severity'.",
			),
			n(
				"cx-10",
				"cx-02",
				"measured",
				"diff against the last release",
				"retrieval",
				"speed",
				22,
				2700,
			),
			n(
				"cx-07",
				"cx-04",
				"measured",
				"trace data across files",
				"decomposition",
				"accuracy",
				28,
				7400,
			),
			n(
				"cx-08",
				"cx-04",
				"measured",
				"stop after the first finding",
				"budget",
				"speed",
				22,
				3100,
			),
			n(
				"cx-09",
				"cx-07",
				"pending",
				"never print the secrets it finds",
				"other",
				"ethics",
				31,
				7500,
			),
		],
	},

	openhands: {
		key: "openhands",
		benchName: "data analysis tasks",
		total: 40,
		model: "gemini-2.5-pro",
		nodes: [
			n(
				"oh-00",
				null,
				"root",
				"OpenHands, default settings",
				"other",
				"",
				20,
				5600,
			),
			n(
				"oh-01",
				"oh-00",
				"measured",
				"load a sample before the full file",
				"retrieval",
				"speed",
				25,
				4100,
			),
			n(
				"oh-02",
				"oh-00",
				"measured",
				"use pandas for every task",
				"loop",
				"code quality",
				24,
				6100,
			),
			n(
				"oh-03",
				"oh-01",
				"measured",
				"check column types first",
				"verification",
				"accuracy",
				30,
				4700,
			),
			n(
				"oh-04",
				"oh-01",
				"measured",
				"drop rows with missing values",
				"other",
				"speed",
				21,
				3800,
			),
			n(
				"oh-05",
				"oh-01",
				"blocked",
				"upload the data to a web tool",
				"other",
				"speed",
				0,
				0,
				"sandbox-violation",
				"harness/tools.ts: sends task data to an external host. Data may not leave the sandbox.",
			),
			n(
				"oh-09",
				"oh-02",
				"measured",
				"vectorise the loops",
				"loop",
				"speed",
				28,
				5000,
			),
			n(
				"oh-06",
				"oh-03",
				"measured",
				"plot the data before concluding",
				"verification",
				"accuracy",
				34,
				5200,
			),
			n(
				"oh-07",
				"oh-03",
				"measured",
				"answer with one number only",
				"prompt",
				"token savings",
				29,
				3000,
			),
			n(
				"oh-08",
				"oh-06",
				"pending",
				"state the uncertainty of each result",
				"prompt",
				"trust",
				37,
				5600,
			),
		],
	},
};

/**
 * Expands a compact showcase tree into the same shape as a real export, so the
 * renderers never need to know which kind of tree they are drawing.
 */
export function buildShowcaseTree(t) {
	validateShowcaseTree(t);
	const bp = 10000 / t.total;
	const byId = new Map(t.nodes.map((m) => [m.id, m]));

	const nodes = t.nodes.map((m, i) => {
		const parentTasks = byId.get(m.parent)?.tasks ?? m.tasks;
		const delta = (m.tasks - parentTasks) * bp;

		let status;
		let code;
		let reason;
		if (m.kind === "root") {
			status = "accepted";
			code = "ROOT_BASELINE";
			reason =
				"The starting point. Every other version is measured against its parent, back to this one.";
		} else if (m.kind === "blocked") {
			status = "pending";
			code = "INSUFFICIENT_VERIFICATIONS";
			reason =
				"Stopped before measuring, so no key can verify a score. The attempt is kept as a record.";
		} else if (m.kind === "pending") {
			status = "pending";
			code = "INSUFFICIENT_VERIFICATIONS";
			reason = `1 of 2 verifications. It claims ${m.tasks}/${t.total} tasks and waits for a second key.`;
		} else if (delta >= MARGIN) {
			status = "accepted";
			code = "WIN";
			reason = `2 verifications from distinct keys, each at or above +${MARGIN}bp. Worst delta +${delta}bp.`;
		} else if (delta <= -MARGIN) {
			status = "rejected";
			code = "REGRESSION";
			reason = `2 verifications at or below -${MARGIN}bp. The change made the harness worse. Kept.`;
		} else {
			status = "rejected";
			code = "WITHIN_NOISE";
			reason = `The change was inside the ${MARGIN}bp margin, so it is rejected as a tie. Kept.`;
		}

		// A measured node was checked by two keys; a pending one by a single key;
		// a blocked one never ran, so nobody could check it.
		const keys = m.kind === "measured" ? 2 : m.kind === "pending" ? 1 : 0;
		const verifications = Array.from({ length: keys }, (_, k) => ({
			reportId: `${m.id}-report-${k + 1}`,
			runner: `key-${KEYS[k].toLowerCase()}`,
			runnerLabel: `key ${KEYS[k]}`,
			counted: true,
			ignoredWhy: "",
			mode: "live",
			runs: 5,
			clean: true,
			spreadBp: 0,
			deltaMedianBp: delta,
			parent: {
				node: m.parent ?? "root",
				medianBp: parentTasks * bp,
				total: t.total,
				runs: [],
			},
			candidate: {
				node: m.id,
				medianBp: m.tasks * bp,
				total: t.total,
				runs: [],
			},
		}));

		return {
			showcase: true,
			objective: m.objective || undefined,
			id: m.id,
			short: m.id,
			label: m.id,
			seq: i + 1,
			parent: m.parent ?? "root",
			author: "author",
			hypothesis: m.hyp,
			status,
			statusCode: code,
			statusReason: reason,
			verifiedDeltaBp: m.kind === "measured" ? delta : null,
			disputed: false,
			mode: "live",
			trust: "local-unverified",
			detail: {
				proposal: {
					hypothesis: m.hyp,
					falsifiedIf: `The score does not rise by at least ${MARGIN}bp.`,
					primaryArea: m.area,
					motif: m.hyp
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-|-$/g, "")
						.slice(0, 32),
					predictedDelta: MARGIN,
					reasoning: "",
					metric: "score",
				},
				derivedAreas: [m.area],
				claimedMedianBp: m.tasks * bp,
				claimedRuns: [],
				provenance: { source: "showcase", model: t.model },
				...(m.kind === "blocked"
					? {
							mechanical: {
								cls: m.cls,
								command: "",
								exitCode: m.cls === "typecheck-failed" ? 2 : 1,
								evidence: m.evidence,
							},
						}
					: {}),
			},
			diff: "",
			verifications,
			// Time follows token use, so a cheaper change is also a little faster.
			costs: {
				medianTokens: m.tokens * t.total,
				medianWallMs: Math.round(m.tokens * 0.45),
				tokensPerTask: m.tokens,
			},
		};
	});

	const count = (s) => nodes.filter((x) => x.status === s).length;
	const accepted = nodes.filter((x) => x.status === "accepted");
	const head = accepted.reduce(
		(best, node) =>
			best === null || node.detail.claimedMedianBp > best.detail.claimedMedianBp
				? node
				: best,
		null,
	);

	return {
		showcase: true,
		protocol: "petri/export/1",
		generatedAt: 0,
		tree: t.key,
		mode: "live",
		trust: "local-unverified",
		ledger: { kind: "local", lastSeq: 0, topicId: "" },
		hedera: null,
		bench: { id: t.key, name: t.benchName, total: t.total },
		policy: {
			minDeltaBp: MARGIN,
			minRuns: 5,
			minVerifications: 2,
			maxRunSpreadBp: 3000,
			maxRunnerDisagreementBp: 1000,
		},
		runsPerVerification: 5,
		stats: {
			total: nodes.length,
			accepted: count("accepted"),
			rejected: count("rejected"),
			pending: count("pending"),
			contested: count("contested"),
			head: head?.id ?? "",
			tips: accepted
				.filter(
					(a) =>
						!nodes.some((c) => c.parent === a.id && c.status === "accepted"),
				)
				.map((a) => a.id),
		},
		nodes,
	};
}
