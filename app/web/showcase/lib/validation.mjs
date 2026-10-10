import { STATUS_WORD } from "./format.mjs";
import { OBJECTIVES } from "./objectives.mjs";

// Generated selection CSS grows with every node pair; these are static-site limits.
export const MAX_NODES = 256;
export const MAX_DEPTH = 64;
const MAX_VERIFICATIONS = 32;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function requireValue(condition, message) {
	if (!condition) throw new Error(message);
}

function object(value, label) {
	requireValue(
		value !== null && typeof value === "object" && !Array.isArray(value),
		`${label} must be an object`,
	);
}

function text(value, label, allowEmpty = false) {
	requireValue(
		typeof value === "string" && (allowEmpty || value.trim().length > 0),
		`${label} must be ${allowEmpty ? "a string" : "a nonempty string"}`,
	);
}

function number(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
	requireValue(
		typeof value === "number" &&
			Number.isFinite(value) &&
			value >= min &&
			value <= max,
		`${label} must be a finite number between ${min} and ${max}`,
	);
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
	number(value, label, min, max);
	requireValue(Number.isSafeInteger(value), `${label} must be an integer`);
}

function safeSlug(value, label) {
	text(value, label);
	requireValue(
		value.length <= 120 && SAFE_SLUG.test(value),
		`${label} must be a lowercase, path- and selector-safe slug (letters, digits, hyphens; at most 120 characters)`,
	);
}

export function validateRegistryEntry(entry, showcaseTrees) {
	object(entry, "Tree registry entry");
	safeSlug(entry.slug, "Tree registry slug");
	requireValue(
		!["index", "styles", "con", "prn", "aux", "nul"].includes(entry.slug) &&
			!/^(com|lpt)[1-9]$/.test(entry.slug),
		`Tree registry slug ${entry.slug} is reserved and would collide with site files or device names`,
	);
	const label = `Tree ${entry.slug}`;
	requireValue(
		entry.source === "showcase" || entry.source === "real",
		`${label}: unsupported source ${JSON.stringify(entry.source)}; expected showcase or real`,
	);
	for (const key of ["harness", "model", "domain", "goal"])
		text(entry[key], `${label}.${key}`);
	integer(entry.bench, `${label}.bench`, 1, 10000);
	if (entry.source === "showcase") {
		text(entry.showcaseKey, `${label}.showcaseKey`);
		requireValue(
			Object.hasOwn(showcaseTrees, entry.showcaseKey),
			`${label}: unknown showcase key ${JSON.stringify(entry.showcaseKey)}`,
		);
	}
}

export function validateRegistry(entries, showcaseTrees) {
	requireValue(
		Array.isArray(entries) && entries.length > 0,
		"Tree registry must contain at least one entry",
	);
	const slugs = new Set();
	for (const entry of entries) {
		validateRegistryEntry(entry, showcaseTrees);
		requireValue(
			!slugs.has(entry.slug),
			`Tree registry contains duplicate slug ${entry.slug}`,
		);
		slugs.add(entry.slug);
	}
}

/** Missing parents are intentional roots in partial exports; cycles are not. */
export function validateTopology(nodes, label = "Tree") {
	requireValue(
		Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX_NODES,
		`${label}: nodes must contain 1 to ${MAX_NODES} entries`,
	);
	const byId = new Map();
	for (const node of nodes) {
		object(node, `${label} node`);
		text(node.id, `${label} node.id`);
		requireValue(
			node.id !== "root",
			`${label}: node id root is reserved for the parent sentinel`,
		);
		requireValue(!byId.has(node.id), `${label}: duplicate node id ${node.id}`);
		requireValue(
			node.parent === null || typeof node.parent === "string",
			`${label} node ${node.id}: parent must be a string or null`,
		);
		byId.set(node.id, node);
	}

	const depths = new Map();
	for (const node of nodes) {
		const path = [];
		const seen = new Set();
		let current = node;
		while (current && !depths.has(current.id)) {
			requireValue(
				!seen.has(current.id),
				`${label}: parent cycle involving node ${current.id}`,
			);
			seen.add(current.id);
			path.push(current);
			current = byId.get(current.parent);
		}
		let depth = current ? depths.get(current.id) + 1 : 0;
		for (const ancestor of path.reverse()) {
			requireValue(
				depth <= MAX_DEPTH,
				`${label}: node ${ancestor.id} exceeds maximum depth ${MAX_DEPTH}`,
			);
			depths.set(ancestor.id, depth++);
		}
	}
}

export function validateShowcaseTree(tree) {
	object(tree, "Showcase tree");
	text(tree.key, "Showcase tree.key");
	const label = `Showcase ${tree.key}`;
	integer(tree.total, `${label}.total`, 1, 10000);
	text(tree.benchName, `${label}.benchName`);
	text(tree.model, `${label}.model`);
	validateTopology(tree.nodes, label);
	const ids = new Set(tree.nodes.map((node) => node.id));
	for (const node of tree.nodes) {
		const nodeLabel = `${label} node ${node.id}`;
		safeSlug(node.id, `${nodeLabel}.id`);
		requireValue(
			["root", "measured", "pending", "blocked"].includes(node.kind),
			`${nodeLabel}: unsupported kind ${JSON.stringify(node.kind)}`,
		);
		requireValue(
			(node.kind === "root") ===
				(node.parent === null ||
					node.parent === "root" ||
					!ids.has(node.parent)),
			`${nodeLabel}: root kind must match its parent topology`,
		);
		integer(node.tasks, `${nodeLabel}.tasks`, 0, tree.total);
		number(node.tokens, `${nodeLabel}.tokens`);
		text(node.hyp, `${nodeLabel}.hyp`);
		safeSlug(node.area, `${nodeLabel}.area`);
		if (node.kind !== "root")
			requireValue(
				OBJECTIVES.includes(node.objective),
				`${nodeLabel}: unsupported objective ${JSON.stringify(node.objective)}`,
			);
		if (node.kind === "blocked") {
			text(node.cls, `${nodeLabel}.cls`);
			text(node.evidence, `${nodeLabel}.evidence`);
		}
	}
}

function validateHederaRef(ref, label) {
	if (ref === null || ref === undefined) return;
	object(ref, label);
	integer(ref.seq, `${label}.seq`, 1);
	if (ref.timestamp)
		requireValue(
			typeof ref.timestamp === "string" && /^\d+\.\d+$/.test(ref.timestamp),
			`${label}.timestamp must be numeric seconds.nanoseconds`,
		);
}

function validateVerification(verification, node, tree, label) {
	object(verification, label);
	text(verification.runner, `${label}.runner`);
	requireValue(
		typeof verification.counted === "boolean",
		`${label}.counted must be boolean`,
	);
	integer(verification.runs, `${label}.runs`, 1, 10000);
	if (verification.counted)
		requireValue(
			verification.runs >= tree.policy.minRuns,
			`${label}.runs must meet policy minimum ${tree.policy.minRuns} for a counted report`,
		);
	number(verification.deltaMedianBp, `${label}.deltaMedianBp`, -10000, 10000);
	for (const side of ["parent", "candidate"]) {
		object(verification[side], `${label}.${side}`);
		number(verification[side].medianBp, `${label}.${side}.medianBp`, 0, 10000);
		requireValue(
			verification[side].total === tree.bench.total,
			`${label}.${side}.total must match benchmark total ${tree.bench.total}`,
		);
	}
	requireValue(
		verification.candidate.node === node.id,
		`${label}.candidate.node must match ${node.id}`,
	);
	requireValue(
		verification.parent.node === (node.parent ?? "root"),
		`${label}.parent.node must match the node's parent`,
	);
	if (tree.hedera) validateHederaRef(verification.hedera, `${label}.hedera`);
}

/** Validate once at the build boundary, before any HTML or CSS is generated. */
export function validateTree(tree, entry) {
	object(tree, "Tree snapshot");
	const label = `Tree ${entry?.slug ?? tree.tree ?? "snapshot"}`;
	object(tree.bench, `${label}.bench`);
	integer(tree.bench.total, `${label}.bench.total`, 1, 10000);
	if (entry)
		requireValue(
			tree.bench.total === entry.bench,
			`${label}: benchmark total ${tree.bench.total} does not match registry bench ${entry.bench}`,
		);
	object(tree.policy, `${label}.policy`);
	number(tree.policy.minDeltaBp, `${label}.policy.minDeltaBp`, 0, 10000);
	integer(tree.policy.minRuns, `${label}.policy.minRuns`, 1, 10000);
	integer(
		tree.policy.minVerifications,
		`${label}.policy.minVerifications`,
		1,
		MAX_VERIFICATIONS,
	);
	for (const key of ["maxRunSpreadBp", "maxRunnerDisagreementBp"])
		number(tree.policy[key], `${label}.policy.${key}`, 0, 10000);
	integer(
		tree.runsPerVerification,
		`${label}.runsPerVerification`,
		tree.policy.minRuns,
		10000,
	);
	requireValue(
		["live", "replay"].includes(tree.mode),
		`${label}.mode must be live or replay`,
	);
	if (tree.hedera) {
		object(tree.hedera, `${label}.hedera`);
		requireValue(
			["mainnet", "testnet", "previewnet"].includes(tree.hedera.network),
			`${label}.hedera.network must be mainnet, testnet, or previewnet`,
		);
		requireValue(
			typeof tree.hedera.topicId === "string" &&
				/^\d+\.\d+\.\d+$/.test(tree.hedera.topicId),
			`${label}.hedera.topicId must be a numeric shard.realm.topic id`,
		);
	}
	validateTopology(tree.nodes, label);
	const shorts = new Set();
	const ids = new Set(tree.nodes.map((node) => node.id));
	const counts = Object.fromEntries(
		Object.keys(STATUS_WORD).map((status) => [status, 0]),
	);
	for (const node of tree.nodes) {
		const nodeLabel = `${label} node ${node.id}`;
		safeSlug(node.short, `${nodeLabel}.short`);
		requireValue(
			!shorts.has(node.short),
			`${label}: duplicate node short ${node.short}`,
		);
		shorts.add(node.short);
		requireValue(
			Object.hasOwn(STATUS_WORD, node.status),
			`${nodeLabel}: unsupported status ${JSON.stringify(node.status)}`,
		);
		counts[node.status]++;
		integer(node.seq, `${nodeLabel}.seq`, 0);
		text(node.hypothesis, `${nodeLabel}.hypothesis`);
		text(node.statusCode, `${nodeLabel}.statusCode`);
		text(node.statusReason, `${nodeLabel}.statusReason`);
		text(node.diff, `${nodeLabel}.diff`, true);
		requireValue(
			node.mode === tree.mode,
			`${nodeLabel}.mode must match tree mode ${tree.mode}`,
		);
		object(node.detail, `${nodeLabel}.detail`);
		number(
			node.detail.claimedMedianBp,
			`${nodeLabel}.detail.claimedMedianBp`,
			0,
			10000,
		);
		object(node.detail.proposal, `${nodeLabel}.detail.proposal`);
		safeSlug(
			node.detail.proposal.primaryArea,
			`${nodeLabel}.detail.proposal.primaryArea`,
		);
		number(
			node.detail.proposal.predictedDelta,
			`${nodeLabel}.detail.proposal.predictedDelta`,
			-10000,
			10000,
		);
		requireValue(
			["score", "tokens"].includes(node.detail.proposal.metric),
			`${nodeLabel}.detail.proposal.metric must be score or tokens`,
		);
		if (node.objective !== undefined)
			requireValue(
				OBJECTIVES.includes(node.objective),
				`${nodeLabel}: unsupported objective ${JSON.stringify(node.objective)}`,
			);
		if (node.detail.mechanical !== undefined) {
			object(node.detail.mechanical, `${nodeLabel}.detail.mechanical`);
			text(node.detail.mechanical.cls, `${nodeLabel}.detail.mechanical.cls`);
			text(
				node.detail.mechanical.evidence,
				`${nodeLabel}.detail.mechanical.evidence`,
				true,
			);
		}
		if (node.verifiedDeltaBp !== null)
			number(
				node.verifiedDeltaBp,
				`${nodeLabel}.verifiedDeltaBp`,
				-10000,
				10000,
			);
		object(node.costs, `${nodeLabel}.costs`);
		for (const key of ["medianTokens", "medianWallMs", "tokensPerTask"])
			number(node.costs[key], `${nodeLabel}.costs.${key}`);
		requireValue(
			Array.isArray(node.verifications) &&
				node.verifications.length <= MAX_VERIFICATIONS,
			`${nodeLabel}.verifications must be an array with at most ${MAX_VERIFICATIONS} entries`,
		);
		for (const [index, verification] of node.verifications.entries())
			validateVerification(
				verification,
				node,
				tree,
				`${nodeLabel} verification ${index + 1}`,
			);
		const counted = node.verifications.filter(
			(verification) => verification.counted,
		);
		requireValue(
			new Set(counted.map((verification) => verification.runner)).size ===
				counted.length,
			`${nodeLabel}: counted verifications must come from distinct runner keys`,
		);
		const root =
			node.parent === null || node.parent === "root" || !ids.has(node.parent);
		if (!root && ["accepted", "rejected"].includes(node.status)) {
			requireValue(
				counted.length >= tree.policy.minVerifications,
				`${nodeLabel}: ${node.status} status requires ${tree.policy.minVerifications} counted verifications`,
			);
		}
		if (node.detail.mechanical && node.detail.mechanical.cls !== "ok") {
			requireValue(
				counted.length === 0,
				`${nodeLabel}: blocked or unscored nodes cannot have counted verifications`,
			);
		}
		if (tree.hedera) validateHederaRef(node.hedera, `${nodeLabel}.hedera`);
	}

	object(tree.stats, `${label}.stats`);
	requireValue(
		tree.stats.total === tree.nodes.length,
		`${label}.stats.total must match node count ${tree.nodes.length}`,
	);
	for (const [status, count] of Object.entries(counts))
		requireValue(
			(tree.stats[status] ?? 0) === count,
			`${label}.stats.${status} must match node count ${count}`,
		);
	const head = tree.nodes.find((node) => node.id === tree.stats.head);
	if (tree.stats.head === "") {
		requireValue(
			counts.accepted === 0,
			`${label}.stats.head must name an accepted node when one exists`,
		);
	} else {
		requireValue(
			head !== undefined,
			`${label}.stats.head references missing node ${JSON.stringify(tree.stats.head)}`,
		);
		requireValue(
			head.status === "accepted",
			`${label}.stats.head must name an accepted node`,
		);
	}
}
