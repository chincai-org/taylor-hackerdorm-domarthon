import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { assert };
export const TREE = "research--hermes-agent--claude-sonnet-5";
export const PETRI = "coding--petri-harness-v1--claude-sonnet-5";
export const PAGES = [
	"index",
	TREE,
	PETRI,
	"finance--pi--claude-haiku-4-5",
	"security--codex-cli--gpt-5",
	"data-analysis--openhands--gemini-2-5-pro",
	"coding--claude-code--claude-opus-5",
];
export const pageURL = (name = TREE, hash = "") =>
	new URL(`../dist/${name}.html${hash}`, import.meta.url).href;
export const shotPath = (name) =>
	fileURLToPath(new URL(`../../shots/checks/${name}`, import.meta.url));

const require = createRequire(import.meta.url);
const managedPlaywright = join(
	homedir(),
	".workbuddy-ai/binaries/node/workspace/node_modules/playwright-core",
);
const playwright = () => {
	if (process.env.PLAYWRIGHT_MODULE_PATH) {
		return require(process.env.PLAYWRIGHT_MODULE_PATH);
	}
	try {
		return require("playwright-core");
	} catch (error) {
		if (error.code !== "MODULE_NOT_FOUND") throw error;
		return require(managedPlaywright);
	}
};

// Playwright remains a development tool; the delivered pages have no dependencies.
// Override its package path and browser with PLAYWRIGHT_MODULE_PATH,
// BROWSER_EXECUTABLE_PATH, or BROWSER_CHANNEL when running on another machine.
export async function withBrowser(run, options = {}) {
	const { preserveClipboard = false, ...contextOptions } = options;
	const launch = process.env.BROWSER_EXECUTABLE_PATH
		? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
		: {
				channel:
					process.env.BROWSER_CHANNEL ??
					(process.platform === "win32" ? "msedge" : undefined),
			};
	const browser = await playwright().chromium.launch({
		timeout: 15000,
		...launch,
	});
	let clipboardPage;
	let clipboardText;
	try {
		if (preserveClipboard) {
			const clipboardContext = await browser.newContext({
				permissions: ["clipboard-read", "clipboard-write"],
			});
			clipboardPage = await clipboardContext.newPage();
			await clipboardPage.goto(pageURL("index"), {
				waitUntil: "domcontentloaded",
			});
			clipboardText = await clipboardPage.evaluate(() =>
				navigator.clipboard.readText(),
			);
		}
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			colorScheme: "dark",
			reducedMotion: "reduce",
			...contextOptions,
		});
		const page = await context.newPage();
		page.setDefaultTimeout(10000);
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await run(page, browser);
		assert.deepEqual(errors, [], "No uncaught browser errors");
	} finally {
		try {
			if (clipboardText !== undefined) {
				await clipboardPage.evaluate(
					(text) => navigator.clipboard.writeText(text),
					clipboardText,
				);
			}
		} finally {
			await browser.close();
		}
	}
}

export async function open(page, name = TREE, hash = "") {
	// `load` does not settle reliably for file:// when scripting is disabled.
	await page.goto(pageURL(name, hash), {
		waitUntil: "domcontentloaded",
		timeout: 15000,
	});
	await page.evaluate(() => document.fonts.ready);
}

export async function selection(page) {
	return page.evaluate(() => {
		const visible = (selector) =>
			[...document.querySelectorAll(selector)].filter(
				(element) =>
					element.getBoundingClientRect().width &&
					element.getBoundingClientRect().height,
			);
		return {
			strips: visible(".selected-strip").map((element) => element.dataset.for),
			records: visible(".rec").map((element) => element.dataset.for),
			panels: visible(".node-panel").length,
			info: visible(".panel").map((element) => element.dataset.panel),
			tree: visible(".view-tree").length,
			stats: visible(".view-stats").length,
			hash: location.hash,
		};
	});
}

export async function expectSelection(page, short) {
	await page.locator(`.rec[data-for="${short}"]`).waitFor({ state: "visible" });
	const state = await selection(page);
	assert.deepEqual(
		state.strips,
		[short],
		"Exactly the chosen strip is visible",
	);
	assert.deepEqual(
		state.records,
		[short],
		"Exactly the chosen record is visible",
	);
	assert.equal(state.panels, 1, "Exactly one node panel is visible");
	return state;
}

export async function checkNativeInteractions(page, javaScriptEnabled) {
	await open(page);
	assert.equal(
		await page
			.locator("html")
			.evaluate((element) => element.classList.contains("has-js")),
		javaScriptEnabled,
	);
	await expectSelection(page, "he-08");
	assert.equal((await selection(page)).tree, 1);
	assert.equal((await selection(page)).stats, 0);

	const node = page.locator('.h-node[href="#s-he-07"]');
	await node.scrollIntoViewIfNeeded();
	const scrollBefore = await page.evaluate(() => window.scrollY);
	await node.click();
	assert.equal((await expectSelection(page, "he-07")).hash, "#s-he-07");
	if (javaScriptEnabled) {
		assert.equal(
			await page.evaluate(() => window.scrollY),
			scrollBefore,
			"Enhanced figure selection does not jump to the record",
		);
	}
	await page.evaluate(() => window.scrollTo(0, 0));
	const recordTop = await page
		.locator("#s-he-07")
		.evaluate((element) => element.getBoundingClientRect().top);
	assert.ok(
		recordTop > 64,
		"The record begins below its anchor destination before Full record",
	);
	await page
		.locator('.selected-strip[data-for="he-07"] a[href="#s-he-07"]')
		.click();
	await expectSelection(page, "he-07");
	const position = await page.locator("#s-he-07").evaluate((element) => ({
		top: element.getBoundingClientRect().top,
		scroll: window.scrollY,
	}));
	assert.ok(position.scroll > 0, "Full record actually scrolls the document");
	assert.ok(
		position.top >= 50 && position.top <= 70,
		`Record clears the header: ${position.top}px`,
	);

	const parent = page.locator('.rec[data-for="he-07"] .parent-link a');
	const parentShort = (await parent.getAttribute("href")).slice(3);
	await parent.click();
	await expectSelection(page, parentShort);
	const parentPosition = await page
		.locator(`#s-${parentShort}`)
		.evaluate((element) => ({
			top: element.getBoundingClientRect().top,
			scroll: window.scrollY,
		}));
	assert.ok(
		parentPosition.scroll > 0,
		"Parent navigation scrolls to its record",
	);
	assert.ok(
		parentPosition.top >= 50 && parentPosition.top <= 70,
		`Parent record clears the header: ${parentPosition.top}px`,
	);

	await page.setViewportSize({ width: 390, height: 844 });
	await open(page);
	const row = page.locator('.t-row[href="#s-he-02"]');
	await row.scrollIntoViewIfNeeded();
	const narrowScrollBefore = await page.evaluate(() => window.scrollY);
	await row.click();
	await expectSelection(page, "he-02");
	if (javaScriptEnabled) {
		assert.equal(
			await page.evaluate(() => window.scrollY),
			narrowScrollBefore,
			"Enhanced list selection does not jump to the record",
		);
	}
	await page.setViewportSize({ width: 1440, height: 900 });

	for (const name of [TREE, PETRI]) {
		await open(page, name);
		const chips = await page
			.locator(".chip-input")
			.evaluateAll((elements) => elements.map((element) => element.id));
		assert.ok(chips.length >= 4);
		for (const id of chips) {
			await page.locator(`label[for="${id}"]`).click();
			assert.deepEqual(
				(await selection(page)).info,
				[id.slice(5)],
				"Each chip reveals only its own panel",
			);
			assert.equal(await page.locator(".chip-input:checked").count(), 1);
		}
		await page.locator(`label[for="${chips[0]}"]`).click();
		await page.keyboard.press("ArrowRight");
		assert.equal(
			await page.locator(`#${chips[1]}`).isChecked(),
			true,
			"Arrow keys change native chip radios",
		);
		assert.deepEqual((await selection(page)).info, [chips[1].slice(5)]);
		assert.equal(
			await page
				.locator(`#${chips[1]}`)
				.evaluate((element) => element === document.activeElement),
			true,
		);
		await page.keyboard.press("ArrowLeft");
		assert.equal(await page.locator(`#${chips[0]}`).isChecked(), true);

		await page.locator('label[for="view-tree"]').click();
		await page.keyboard.press("ArrowRight");
		assert.equal(
			await page.locator("#view-stats").isChecked(),
			true,
			"Arrow keys change native view radios",
		);
		assert.equal((await selection(page)).tree, 0);
		assert.equal((await selection(page)).stats, 1);
		await page.keyboard.press("ArrowLeft");
		assert.equal((await selection(page)).tree, 1);
		assert.equal((await selection(page)).stats, 0);
	}

	await open(page, "index");
	const links = await page
		.locator("a.card")
		.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("href")),
		);
	assert.equal(links.length, 6, "Six native gallery links");
	assert.equal(new Set(links).size, 6);
	await open(page);
	const nodeCount = await page.locator(".h-node").count();
	await page.locator('label[for="view-stats"]').click();
	const table = page.locator("details.table-view");
	assert.equal(await table.getAttribute("open"), null);
	assert.equal(await table.locator("table").isVisible(), false);
	await table.locator("summary").click();
	assert.equal(
		await table.locator("table").isVisible(),
		true,
		"Native details reveals the stats table",
	);
	assert.equal(await table.locator("tbody tr").count(), nodeCount);
	await table.locator("summary").press("Enter");
	assert.equal(
		await table.locator("table").isVisible(),
		false,
		"Keyboard closes native details",
	);
	console.log(
		`${javaScriptEnabled ? "JS-on" : "JS-off"}: selection, native scroll, chips, radio keyboard and stats details passed`,
	);
}

export async function expectCopied(button, copied = true) {
	const icon = button.locator(copied ? ".icon-copied" : ".icon-copy");
	await icon.waitFor({ state: "visible" });
	const label = await button.getAttribute("aria-label");
	if (copied) assert.equal(label, "Copied");
	else
		assert.equal(
			label,
			await button.getAttribute("title"),
			"Original copy label restored",
		);
	assert.equal(
		await button.locator(copied ? ".icon-copy" : ".icon-copied").isVisible(),
		false,
	);
}
