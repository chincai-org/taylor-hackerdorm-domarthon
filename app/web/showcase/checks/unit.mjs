import test from "node:test";
import assert from "node:assert/strict";
import { TREES, loadTree } from "../registry.mjs";
import {
	SHOWCASE_TREES,
	buildShowcaseTree,
	MARGIN,
} from "../data/showcase.mjs";
import {
	claimBp,
	nodeNumbers,
	rootRerunBp,
	scoreBpOf,
	signedBp,
	tasksOf,
} from "../lib/format.mjs";
import { changesOf, fmtPct, gain, metricOf, valueOf } from "../lib/metrics.mjs";
import { buildForest, tidySlots } from "../lib/layout.mjs";
import { glyph } from "../lib/glyph.mjs";
import {
	MAX_DEPTH,
	MAX_NODES,
	validateRegistry,
	validateShowcaseTree,
	validateTopology,
	validateTree,
} from "../lib/validation.mjs";

function node(id, parent = "root", score = 0) {
	return {
		id,
		short: id,
		parent,
		seq: 1,
		status: "accepted",
		objective: "accuracy",
		detail: {
			claimedMedianBp: score,
			proposal: { metric: "score", predictedDelta: 0 },
		},
		costs: { tokensPerTask: 100, medianWallMs: 200 },
		verifications: [],
	};
}

function verification(
	parent,
	candidate,
	parentScore,
	candidateScore,
	counted = true,
) {
	return {
		counted,
		parent: { node: parent, medianBp: parentScore },
		candidate: { node: candidate, medianBp: candidateScore },
		deltaMedianBp: candidateScore - parentScore,
	};
}

function snapshot() {
	return buildShowcaseTree(structuredClone(SHOWCASE_TREES.hermes));
}

function treeFailure(mutate, pattern) {
	const tree = snapshot();
	mutate(tree);
	assert.throws(() => validateTree(tree), pattern);
}

test("every bundled tree passes boundary validation and lays out every node", () => {
	for (const entry of TREES) {
		const { tree } = loadTree(entry);
		assert.doesNotThrow(() => validateTree(tree, entry));
		const statuses = new Map(tree.nodes.map((item) => [item.id, item.status]));
		const layout = tidySlots(buildForest(tree.nodes), (id) => statuses.get(id));
		assert.equal(layout.slots.size, tree.nodes.length);
	}
});

test("score selection preserves a zero root claim and a zero counted measurement", () => {
	const root = node("base", "root", 0);
	assert.equal(scoreBpOf(root, [root]), 0);
	assert.equal(valueOf(root, "score", [root]), 0);
	const candidate = node("child", root.id, 9000);
	candidate.verifications = [verification(root.id, candidate.id, 0, 0)];
	assert.equal(scoreBpOf(candidate, [root, candidate]), 0);
});

test("verified node summaries display the counted candidate rather than the author claim", () => {
	const root = node("base", "root", 4000);
	const child = node("child", root.id, 9000);
	child.verifiedDeltaBp = 1000;
	child.verifications = [
		verification(root.id, child.id, 4000, 9000, false),
		verification(root.id, child.id, 4000, 5000),
		verification(root.id, child.id, 4000, 5000),
	];
	assert.equal(
		nodeNumbers(child, [root, child], 20, 2),
		"10/20 tasks · +1000bp · 2 keys agree",
	);
});

test("root scores use a counted child's parent re-run, never an ignored report", () => {
	const root = node("base", "root", 4000);
	const child = node("child", root.id, 7000);
	child.verifications = [
		verification(root.id, child.id, 9000, 10000, false),
		verification(root.id, child.id, 0, 7000),
	];
	assert.equal(rootRerunBp(root, [root, child]), 0);
	assert.equal(scoreBpOf(root, [root, child]), 0);
	assert.equal(
		nodeNumbers(root, [root, child], 20, 2),
		"baseline · 0/20 tasks when re-run",
	);
});

test("unverified and ignored-only candidates fall back to the author claim", () => {
	const root = node("base", "root", 4000);
	const child = node("child", root.id, 0);
	child.verifications = [verification(root.id, child.id, 4000, 9000, false)];
	assert.equal(scoreBpOf(child, [root, child]), 0);
});

test("blocked scores use the predicted parent-based claim and clamp the range", () => {
	const root = node("base", "root", 9500);
	const child = node("child", root.id, 0);
	child.detail.mechanical = { cls: "not-scored" };
	child.detail.proposal.predictedDelta = 1000;
	assert.equal(scoreBpOf(child, [root, child]), 10000);
	child.detail.proposal.predictedDelta = -10000;
	assert.equal(claimBp(child, [root, child]), 0);
	child.detail.proposal.predictedDelta = undefined;
	assert.equal(claimBp(child, [root, child]), 9500);
	child.parent = "omitted-parent";
	assert.equal(claimBp(child, [child]), 0);
});

test("cost metrics distinguish positive observations from missing or unrun costs", () => {
	const item = node("base");
	assert.equal(valueOf(item, "tokens", [item]), 100);
	assert.equal(valueOf(item, "time", [item]), 200);
	for (const missing of [0, undefined, null, NaN, Infinity, -1]) {
		item.costs.tokensPerTask = missing;
		assert.equal(valueOf(item, "tokens", [item]), null);
	}
	item.detail.mechanical = { cls: "typecheck-failed" };
	assert.equal(valueOf(item, "time", [item]), null);
});

test("gains count higher scores and lower costs as improvements", () => {
	assert.equal(gain(4000, 5000, "score"), 25);
	assert.equal(gain(100, 75, "tokens"), 25);
	assert.equal(gain(100, 125, "time"), -25);
	assert.equal(gain(100, 0, "score"), -100);
	for (const missing of [null, undefined, NaN, Infinity]) {
		assert.equal(gain(missing, 100, "score"), null);
		assert.equal(gain(100, missing, "score"), null);
	}
	assert.equal(gain(0, 100, "score"), null);
	assert.equal(fmtPct(null), "—");
	assert.equal(fmtPct(-0.2), "0%");
	assert.equal(fmtPct(-24.6), "−25%");
	assert.equal(metricOf("token savings"), "tokens");
	assert.equal(metricOf("speed"), "time");
	assert.equal(metricOf("trust"), "score");
});

test("changes compare the chosen direction locally and baseline metrics globally", () => {
	const root = node("base", "root", 4000);
	const child = node("child", root.id, 5000);
	child.objective = "token savings";
	child.costs.tokensPerTask = 75;
	assert.deepEqual(changesOf(child, [root, child]), {
		local: 25,
		accuracy: 25,
		tokenSavings: 25,
		isStart: false,
	});
	assert.deepEqual(changesOf(root, [root, child]), {
		local: null,
		accuracy: 0,
		tokenSavings: -0,
		isStart: true,
	});
});

test("missing-parent partial exports remain roots and have no local gain", () => {
	const item = node("partial", "not-in-export", 5000);
	assert.deepEqual(buildForest([item]).roots, [item.id]);
	assert.equal(changesOf(item, [item]).local, null);
	assert.equal(changesOf(item, [item]).isStart, true);
	const tree = snapshot();
	tree.nodes[0].parent = "not-in-export";
	assert.doesNotThrow(() => validateTree(tree));
});

test("forest sibling ranking and accepted middle slots remain stable", () => {
	const root = node("base");
	const accepted = node("accepted", root.id);
	const pending = { ...node("pending", root.id), status: "pending", seq: 2 };
	const rejected = { ...node("rejected", root.id), status: "rejected", seq: 3 };
	const nodes = [root, rejected, pending, accepted];
	const forest = buildForest(nodes);
	assert.deepEqual(forest.children.get(root.id), [
		accepted.id,
		pending.id,
		rejected.id,
	]);
	const statuses = new Map(nodes.map((item) => [item.id, item.status]));
	assert.deepEqual(
		tidySlots(forest, (id) => statuses.get(id)),
		{
			slots: new Map([
				[pending.id, { depth: 1, row: 0 }],
				[accepted.id, { depth: 1, row: 1 }],
				[rejected.id, { depth: 1, row: 2 }],
				[root.id, { depth: 0, row: 1 }],
			]),
			rows: 3,
			maxDepth: 1,
		},
	);
});

test("cycles and duplicate ids fail loudly rather than hiding nodes", () => {
	const nodes = [node("one", "two"), node("two", "one")];
	assert.throws(() => buildForest(nodes), /parent cycle/);
	assert.throws(() => changesOf(nodes[0], nodes), /parent cycle/);
	assert.throws(
		() => buildForest([node("same"), node("same")]),
		/duplicate node id/,
	);
	assert.throws(
		() =>
			tidySlots(
				{ roots: ["one"], children: new Map([["one", ["one"]]]) },
				() => "accepted",
			),
		/repeated or cyclic node/,
	);
});

test("static-site node and depth limits allow the boundary and reject the next item", () => {
	const wide = Array.from({ length: MAX_NODES }, (_, index) =>
		node(`n-${index}`),
	);
	assert.doesNotThrow(() => validateTopology(wide));
	assert.throws(() => validateTopology([...wide, node("extra")]), /1 to 256/);
	const chain = Array.from({ length: MAX_DEPTH + 1 }, (_, index) =>
		node(`n-${index}`, index === 0 ? "root" : `n-${index - 1}`),
	);
	assert.doesNotThrow(() => validateTopology(chain));
	assert.throws(
		() => validateTopology([...chain, node("extra", chain.at(-1).id)]),
		/maximum depth 64/,
	);
	assert.throws(() => validateTopology([]), /nodes must contain/);
});

test("registry failures identify unknown sources, keys, duplicate and unsafe slugs", () => {
	assert.throws(
		() => loadTree({ ...TREES[0], source: "typo" }),
		/unsupported source.*typo/,
	);
	for (const showcaseKey of ["missing", "toString", "__proto__"])
		assert.throws(
			() => loadTree({ ...TREES[0], showcaseKey }),
			/unknown showcase key/,
		);
	for (const slug of [
		"../escape",
		"a/b",
		"A-tree",
		'a"b',
		"a b",
		"-a",
		"a".repeat(121),
	])
		assert.throws(
			() => loadTree({ ...TREES[0], slug }),
			/path- and selector-safe slug/,
		);
	assert.throws(
		() => validateRegistry([TREES[0], TREES[0]], SHOWCASE_TREES),
		/duplicate slug/,
	);
	assert.throws(
		() => loadTree({ ...TREES[0], bench: 20 }),
		/does not match registry bench/,
	);
});

test("snapshot validation rejects duplicate shorts, unsafe selectors, and invalid status", () => {
	treeFailure((tree) => {
		tree.nodes[1].short = tree.nodes[0].short;
	}, /duplicate node short/);
	treeFailure((tree) => {
		tree.nodes[0].short = "a]#other";
	}, /selector-safe slug/);
	treeFailure((tree) => {
		tree.nodes[0].status = "toString";
	}, /unsupported status/);
	treeFailure((tree) => {
		tree.nodes[0].id = "root";
	}, /reserved/);
});

test("snapshot validation rejects invalid scores, costs, policies and benchmark totals", () => {
	for (const cost of [-1, Infinity, NaN, undefined])
		treeFailure((tree) => {
			tree.nodes[0].costs.tokensPerTask = cost;
		}, /costs.tokensPerTask must be a finite number/);
	treeFailure((tree) => {
		tree.nodes[0].detail.claimedMedianBp = 10001;
	}, /claimedMedianBp must be a finite number/);
	treeFailure((tree) => {
		tree.policy.minRuns = 0;
	}, /policy.minRuns/);
	treeFailure((tree) => {
		tree.policy.minVerifications = 33;
	}, /policy.minVerifications/);
	treeFailure((tree) => {
		tree.bench.total = 0;
	}, /bench.total/);
	treeFailure((tree) => {
		tree.nodes[1].verifications[0].candidate.total++;
	}, /candidate.total must match benchmark total/);
	treeFailure((tree) => {
		tree.nodes[1].verifications[0].candidate.node = "other";
	}, /candidate.node must match/);
});

test("snapshot head, counts, and mode must agree with the nodes", () => {
	treeFailure((tree) => {
		tree.stats.head = "missing";
	}, /head references missing node/);
	treeFailure((tree) => {
		tree.stats.head = "he-04";
	}, /head must name an accepted node/);
	treeFailure((tree) => {
		tree.stats.head = "";
	}, /head must name an accepted node when one exists/);
	treeFailure((tree) => {
		tree.stats.accepted++;
	}, /stats.accepted must match node count/);
	treeFailure((tree) => {
		tree.stats.total++;
	}, /stats.total must match node count/);
	treeFailure((tree) => {
		tree.nodes[0].mode = "replay";
	}, /mode must match tree mode/);
});

test("reserved filenames and verification-policy contradictions fail at the boundary", () => {
	for (const slug of ["index", "styles", "con", "com1", "lpt9"]) {
		assert.throws(() => loadTree({ ...TREES[0], slug }), /reserved/);
	}
	treeFailure((tree) => {
		tree.nodes[1].verifications[0].runs = 4;
	}, /runs must meet policy minimum/);
	treeFailure((tree) => {
		tree.nodes[1].verifications.pop();
	}, /accepted status requires/);
	treeFailure((tree) => {
		tree.nodes[1].verifications[1].runner =
			tree.nodes[1].verifications[0].runner;
	}, /distinct runner keys/);
	treeFailure((tree) => {
		tree.nodes[1].detail.mechanical = { cls: "not-scored", evidence: "" };
	}, /cannot have counted verifications/);
	treeFailure((tree) => {
		tree.policy.maxRunSpreadBp = -1;
	}, /policy.maxRunSpreadBp/);
	treeFailure((tree) => {
		tree.nodes[0].detail.proposal.metric = "typo";
	}, /proposal.metric must be score or tokens/);
});

test("only interpolated Hedera URL parts are validated", () => {
	const tree = snapshot();
	tree.hedera = { topicId: "0.0.123", network: "testnet" };
	tree.nodes[0].hedera = {
		seq: 1,
		timestamp: "123456.123",
		txId: "unused arbitrary text",
	};
	assert.doesNotThrow(() => validateTree(tree));
	tree.hedera.network = "../evil";
	assert.throws(() => validateTree(tree), /hedera.network/);
	tree.hedera.network = "testnet";
	tree.hedera.topicId = "123?evil";
	assert.throws(() => validateTree(tree), /hedera.topicId/);
	tree.hedera.topicId = "0.0.123";
	tree.nodes[0].hedera.timestamp = "123/evil";
	assert.throws(() => validateTree(tree), /timestamp must be numeric/);
});

test("showcase acceptance thresholds and compact-data errors are deterministic", () => {
	const compact = structuredClone(SHOWCASE_TREES.hermes);
	compact.nodes = compact.nodes.slice(0, 2);
	compact.nodes[1].tasks =
		compact.nodes[0].tasks + MARGIN / (10000 / compact.total);
	assert.equal(buildShowcaseTree(compact).nodes[1].status, "accepted");
	compact.nodes[1].tasks =
		compact.nodes[0].tasks - MARGIN / (10000 / compact.total);
	assert.equal(buildShowcaseTree(compact).nodes[1].statusCode, "REGRESSION");
	compact.nodes[1].tasks = compact.nodes[0].tasks;
	assert.equal(buildShowcaseTree(compact).nodes[1].statusCode, "WITHIN_NOISE");
	compact.nodes[1].kind = "typo";
	assert.throws(() => validateShowcaseTree(compact), /unsupported kind/);
	assert.throws(
		() => buildShowcaseTree(undefined),
		/Showcase tree must be an object/,
	);
});

test("task formatting and all status glyph shapes remain stable", () => {
	assert.equal(tasksOf(0, 40), 0);
	assert.equal(tasksOf(10000, 40), 40);
	assert.equal(signedBp(null), "not checked yet");
	assert.equal(signedBp(-1000), "−1000bp");
	assert.equal(
		glyph("accepted", 7, 7, 5),
		'<circle class="g-pass" cx="7" cy="7" r="5"/>',
	);
	assert.match(glyph("rejected", 7, 7, 5), /class="g-x"/);
	assert.match(
		glyph("contested", 7, 7, 5),
		/class="g-hollow g-wait" d="M7 2L12 11L2 11Z"/,
	);
	for (const status of ["pending", "withdrawn", "superseded"])
		assert.match(glyph(status, 7, 7, 5), /class="g-dot"/);
});
