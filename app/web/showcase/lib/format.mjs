/**
 * Formatting helpers — a direct port of the reference `lib/format.ts`.
 *
 * These turn raw export numbers into the words the page shows. Keeping them in
 * one module means the tree, the record panel and the stats chart all describe a
 * version the same way, and the CLI's own vocabulary stays the single source of
 * truth for status words.
 */

/** One task is 500bp on a 20-task bench. 100bp is one percentage point. */
export const tasksOf = (bp, total) => Math.round((bp / 10000) * total);
export const tasks = (bp, total) => `${tasksOf(bp, total)} of ${total} tasks`;
export const shortTasks = (bp, total) => `${tasksOf(bp, total)}/${total} tasks`;

/** A signed basis-point delta, with a real minus sign rather than a hyphen. */
export function signedBp(bp) {
	if (bp === null || bp === undefined) return "not checked yet";
	if (bp === 0) return "0bp";
	return `${bp > 0 ? "+" : "\u2212"}${Math.abs(bp)}bp`;
}

/** The CLI's own words, so the page and the terminal never disagree. */
export const STATUS_WORD = {
	accepted: "ACCEPTED",
	rejected: "REJECTED",
	pending: "PENDING",
	contested: "CONTESTED",
	withdrawn: "WITHDRAWN",
	superseded: "SUPERSEDED",
};

export const wordOf = (n) => STATUS_WORD[n.status];

export const counted = (n) => n.verifications.filter((v) => v.counted).length;
export const ignored = (n) => n.verifications.filter((v) => !v.counted).length;

export const isRoot = (n, ids) =>
	n.parent === null || n.parent === "root" || !ids.has(n.parent);

/** A guard or the typecheck stopped this change, so the benchmark never ran. */
export const isBlocked = (n) =>
	n.detail.mechanical !== undefined && n.detail.mechanical.cls !== "ok";

export function clip(text, max) {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}\u2026`;
}

/**
 * A root has no parent, so nobody verifies it directly. The keys that checked
 * its children re-ran it as their "parent" side. Show that number instead.
 */
export function rootRerunBp(root, nodes) {
	for (const n of nodes) {
		if (n.parent !== root.id) continue;
		const v = n.verifications.find((x) => x.counted);
		if (v) return v.parent.medianBp;
	}
	return null;
}

/** The direction a change aims for. A real proposal states its metric: score or tokens. */
export function objectiveOf(n) {
	if (n.objective) return n.objective;
	return n.detail.proposal.metric === "tokens" ? "token savings" : "accuracy";
}

/**
 * The author's claim for a change that was never scored: its parent's score plus
 * the delta the proposal predicted. It is a claim, never a measurement.
 */
export function claimBp(n, nodes) {
	const ids = new Set(nodes.map((x) => x.id));
	const parent = nodes.find((x) => x.id === n.parent);
	const base =
		parent === undefined
			? 0
			: isRoot(parent, ids)
				? (rootRerunBp(parent, nodes) ?? parent.detail.claimedMedianBp)
				: (parent.verifications.find((v) => v.counted)?.candidate.medianBp ??
					parent.detail.claimedMedianBp);
	return Math.max(
		0,
		Math.min(10000, (base ?? 0) + (n.detail.proposal.predictedDelta ?? 0)),
	);
}

/** Score shared by charts and gains; zero is a valid measurement or claim. */
export function scoreBpOf(
	node,
	nodes,
	ids = new Set(nodes.map((item) => item.id)),
) {
	if (isBlocked(node)) return claimBp(node, nodes);
	if (isRoot(node, ids))
		return rootRerunBp(node, nodes) ?? node.detail.claimedMedianBp;
	return (
		node.verifications.find((verification) => verification.counted)?.candidate
			.medianBp ?? node.detail.claimedMedianBp
	);
}

/** The one-line summary that sits under a version in the tree. */
export function nodeNumbers(n, nodes, total, minVer) {
	const ids = new Set(nodes.map((x) => x.id));
	const c = counted(n);

	if (isRoot(n, ids)) {
		const rerun = rootRerunBp(n, nodes);
		return rerun === null
			? `baseline \u00b7 claims ${shortTasks(n.detail.claimedMedianBp, total)}`
			: `baseline \u00b7 ${shortTasks(rerun, total)} when re-run`;
	}
	if (isBlocked(n))
		return `claims ${shortTasks(claimBp(n, nodes), total)} \u00b7 0 of ${minVer} keys`;

	if (n.status === "pending") {
		// One key has measured it: show that measurement, not the author claim.
		const v = n.verifications.find((x) => x.counted);
		return v
			? `${shortTasks(v.candidate.medianBp, total)} \u00b7 ${signedBp(v.deltaMedianBp)} \u00b7 ${c} of ${minVer} keys`
			: `claims ${shortTasks(n.detail.claimedMedianBp, total)} \u00b7 ${c} of ${minVer} keys`;
	}

	return `${shortTasks(scoreBpOf(n, nodes, ids), total)} \u00b7 ${signedBp(n.verifiedDeltaBp)} \u00b7 ${c} ${c === 1 ? "key" : "keys"} agree`;
}
