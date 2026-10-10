// The copy control must sit *inside* the command box, pinned to the inline end,
// for both command blocks (the fork command and the check-it commands) — and it
// must still be there after the direction picker rewrites the fork command.
//
// Why this needs a test rather than an eyeball: the fork command's element is
// rewritten wholesale by `showcase-enhance.js` (`out.textContent = ...`), so if the copy
// button ever ends up *inside* that element it is silently deleted from the DOM
// the first time the picker changes. The button has to be a sibling.
import { assert, open, withBrowser } from "./browser.mjs";

/** Geometry of the box and its button, relative to each other. */
const PROBE = () => {
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return {
			left: +r.left.toFixed(1),
			right: +r.right.toFixed(1),
			top: +r.top.toFixed(1),
			bottom: +r.bottom.toFixed(1),
			w: +r.width.toFixed(1),
			h: +r.height.toFixed(1),
		};
	};

	const inspect = (box) => {
		if (!box) return { found: false };
		const button = box.querySelector("button.copy");
		if (!button) return { found: true, button: false };
		const b = rect(box);
		const t = rect(button);
		// Half a pixel of slack: sub-pixel layout rounds.
		const inside =
			t.left >= b.left - 0.5 &&
			t.right <= b.right + 0.5 &&
			t.top >= b.top - 0.5 &&
			t.bottom <= b.bottom + 0.5;
		return {
			found: true,
			button: true,
			// A hidden box measures 0x0 and would satisfy every containment test
			// vacuously, so report the size and let the caller assert on it.
			visible: b.w > 0 && b.h > 0,
			box: b,
			btn: t,
			inside,
			// Distance from the button to each edge of the box.
			gapRight: +(b.right - t.right).toFixed(1),
			gapLeft: +(t.left - b.left).toFixed(1),
			gapTop: +(t.top - b.top).toFixed(1),
			gapBottom: +(b.bottom - t.bottom).toFixed(1),
			// The command text and button must share the wrapper, never contain each other.
			buttonIsTextSibling:
				button.parentElement === box.querySelector("pre, code")?.parentElement,
			outputOnPre: box.querySelector("[data-fork-out]")?.matches("pre") ?? null,
		};
	};

	/**
	 * Where the browser actually broke the command into rendered lines.
	 *
	 * A command is copied, not read, so a break in the middle of a flag makes it
	 * unusable. Wrapping is fine as long as every line starts where the previous
	 * one ended at whitespace — so walk the text a character at a time, group the
	 * characters by the line box they land in, and report the character that
	 * precedes each line start.
	 */
	const lineBreaks = (el) => {
		const node = el?.firstChild;
		if (!node || node.nodeType !== Node.TEXT_NODE) return null;
		const text = node.textContent;
		const lines = [];
		let current = null;
		for (let i = 0; i < text.length; i++) {
			const range = document.createRange();
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			const rect = range.getBoundingClientRect();
			if (!rect.width && !rect.height) continue; // collapsed whitespace
			if (!current || Math.abs(rect.top - current.top) > 1) {
				current = { top: rect.top, start: i };
				lines.push(current);
			}
		}
		return {
			count: lines.length,
			// `null` for the first line, which has nothing before it.
			breakAfter: lines.map((l) => (l.start === 0 ? null : text[l.start - 1])),
			// A break is only *wrong* when it splits a word that had no break
			// opportunity. Spaces and the explicit newline are the intended ones; a
			// hyphen is also a legitimate opportunity in CSS, so `--flag` ending a
			// line as `--` / `flag` is allowed and reported separately. Anything else
			// is the `overflow-wrap: break-word` failure mode — `improves` becoming
			// `improv` / `es` — which is what this assertion exists to catch.
			midTokenBreaks: lines
				.filter(
					(l) => l.start > 0 && ![" ", "\n", "-"].includes(text[l.start - 1]),
				)
				.map((l) => text.slice(Math.max(0, l.start - 12), l.start + 12)),
			hyphenBreaks: lines
				.filter((l) => l.start > 0 && text[l.start - 1] === "-")
				.map((l) => text.slice(Math.max(0, l.start - 12), l.start + 12)),
			text: text.replace(/\s+/g, " ").trim(),
		};
	};

	// Scope to the record that is actually on show. Every record ships a fork
	// block, but only one is displayed, so an unscoped query measures a 0x0 box
	// belonging to a hidden record and passes every containment test for free.
	const rec = document.querySelector('.rec[data-for="he-08"]');
	const fork = rec?.querySelector(".cmd");
	const checkit = rec?.querySelector(".checkit-cmd");
	const allCheckit = [...(rec?.querySelectorAll(".checkit-cmd") ?? [])];
	return {
		fork: inspect(fork),
		checkit: inspect(checkit),
		forkLines: lineBreaks(fork?.querySelector("pre")),
		// Every check-it command, not just the first: a long flag can appear in any.
		checkitLines: allCheckit.map((row) =>
			lineBreaks(row.querySelector("code")),
		),
		// The command text itself, so a rewrite that clobbers it is visible. Kept
		// whole: the `--motif` flag sits past the 40th character, so a truncated
		// slice makes "did the text change?" compare equal and pass wrongly.
		forkText: fork?.querySelector("pre")?.textContent ?? null,
		forkButtons: fork?.querySelectorAll("button.copy").length ?? 0,
	};
};

await withBrowser(async (p) => {
	const fails = [];
	const check = (ok, what) => {
		if (!ok) fails.push(what);
		console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	};

	for (const width of [1440, 1240, 1020, 700, 390, 360]) {
		await p.setViewportSize({ width, height: 900 });
		await open(p);
		const r = await p.evaluate(PROBE);

		console.log(`\n--- ${width}px ---`);
		console.log(
			`  fork    box ${r.fork.box?.w}x${r.fork.box?.h}  btn ${r.fork.btn?.w}x${r.fork.btn?.h}  gaps L${r.fork.gapLeft} R${r.fork.gapRight} T${r.fork.gapTop} B${r.fork.gapBottom}`,
		);
		console.log(
			`  checkit box ${r.checkit.box?.w}x${r.checkit.box?.h}  btn ${r.checkit.btn?.w}x${r.checkit.btn?.h}  gaps L${r.checkit.gapLeft} R${r.checkit.gapRight} T${r.checkit.gapTop} B${r.checkit.gapBottom}`,
		);

		check(
			r.fork.found && r.fork.button,
			`fork: a copy button exists in the command box`,
		);
		check(
			r.fork.visible,
			`fork: the box is actually on screen (${r.fork.box?.w}x${r.fork.box?.h})`,
		);
		check(r.fork.inside, `fork: the button is inside the box`);
		check(
			r.fork.gapRight < r.fork.gapLeft,
			`fork: the button is pinned right (R${r.fork.gapRight} < L${r.fork.gapLeft})`,
		);
		check(
			Math.abs(r.fork.gapTop - r.fork.gapBottom) <= 1,
			`fork: the button is vertically centred (T${r.fork.gapTop} vs B${r.fork.gapBottom})`,
		);
		check(
			r.fork.buttonIsTextSibling,
			`fork: the button is a sibling of the <pre>, not inside it`,
		);
		check(r.fork.outputOnPre, "fork: data-fork-out stays on the pre element");
		check(
			r.checkit.buttonIsTextSibling,
			"check-it: button is a sibling of the code element",
		);

		check(
			r.checkit.found && r.checkit.button,
			`check-it: a copy button exists in the command box`,
		);
		check(
			r.checkit.visible,
			`check-it: the box is actually on screen (${r.checkit.box?.w}x${r.checkit.box?.h})`,
		);
		check(r.checkit.inside, `check-it: the button is inside the box`);
		check(
			r.checkit.gapRight < r.checkit.gapLeft,
			`check-it: the button is pinned right (R${r.checkit.gapRight} < L${r.checkit.gapLeft})`,
		);
		check(
			Math.abs(r.checkit.gapTop - r.checkit.gapBottom) <= 1,
			`check-it: the button is vertically centred (T${r.checkit.gapTop} vs B${r.checkit.gapBottom})`,
		);
		check(
			r.checkit.box.w <= width,
			`check-it: the box does not overflow the viewport`,
		);

		// Wrapping must never split a *word*: `improves` becoming `improv` / `es`
		// produces a command that reads as garbage. A break at a hyphen is allowed by
		// CSS and is reported but not failed on.
		const midFork = r.forkLines?.midTokenBreaks ?? ["no fork text"];
		check(
			midFork.length === 0,
			`fork: no word split across lines${midFork.length ? ` — ${JSON.stringify(midFork)}` : ""}`,
		);
		const midAll = r.checkitLines.flatMap((l) => l?.midTokenBreaks ?? []);
		check(
			midAll.length === 0,
			`check-it: no word split across lines${midAll.length ? ` — ${JSON.stringify(midAll)}` : ""}`,
		);
		// The wrapping is presentational; the text itself must survive it intact.
		check(
			/pnpm petri propose --parent he-08 --area memory --motif \S+/.test(
				r.forkText ?? "",
			),
			`fork: the command text is intact after wrapping`,
		);
		check(
			r.checkitLines.every((l) =>
				/^pnpm |^PETRI_HOME=|^ANTHROPIC_API_KEY=/.test(l?.text ?? ""),
			),
			`check-it: every command text is intact after wrapping`,
		);
		if (r.forkLines?.hyphenBreaks.length)
			console.log(
				`  note  fork: hyphen break (allowed): ${JSON.stringify(r.forkLines.hyphenBreaks)}`,
			);
	}

	// The picker rewrites the <pre>'s textContent. The button must survive that.
	console.log(`\n--- changing the direction picker ---`);
	await p.setViewportSize({ width: 1440, height: 900 });
	await open(p);
	const before = await p.evaluate(PROBE);
	await p.selectOption(
		'.rec[data-for="he-08"] select[data-fork]',
		"token savings",
	);
	const after = await p.evaluate(PROBE);
	console.log(
		`  fork text before: ${before.forkText?.replace(/\s+/g, " ").slice(0, 72)}`,
	);
	console.log(
		`  fork text after:  ${after.forkText?.replace(/\s+/g, " ").slice(0, 72)}`,
	);
	console.log(`  buttons in the box after the change: ${after.forkButtons}`);
	check(
		after.forkText !== before.forkText,
		`the fork command was rewritten by the picker`,
	);
	check(
		after.forkText?.includes("--motif token-savings"),
		`the rewritten command carries the new motif`,
	);
	check(
		after.forkButtons === 1,
		`the copy button survived the rewrite (still exactly 1)`,
	);
	check(
		after.fork.inside,
		`the button is still inside the box after the rewrite`,
	);

	// Real command widths do not distinguish normal wrapping from break-word.
	// An overlong unhyphenated token makes the mid-word-break regression observable.
	await p.setViewportSize({ width: 360, height: 900 });
	await p.locator('.rec[data-for="he-08"] .cmd pre').evaluate((element) => {
		element.textContent = "x".repeat(200);
	});
	const synthetic = await p.evaluate(PROBE);
	check(
		synthetic.forkLines?.midTokenBreaks.length === 0,
		"synthetic overlong token is not split mid-word",
	);
	console.log(`\n${fails.length} failure(s)`);
	assert.deepEqual(fails, [], "Command box geometry and text integrity");
});
