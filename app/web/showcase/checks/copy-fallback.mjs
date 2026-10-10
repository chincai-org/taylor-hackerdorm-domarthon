import { assert, expectCopied, open, withBrowser } from "./browser.mjs";

const BUTTON =
	'.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]';
const FORK = '.rec[data-for="he-08"] button.copy[data-copy-out="he-08"]';

async function expectFailure(button) {
	await button.page().waitForFunction(
		(selector) => {
			const button = document.querySelector(selector);
			return button.nextElementSibling.textContent.startsWith("Copy failed");
		},
		(await button.getAttribute("data-copy-out")) ? FORK : BUTTON,
	);
	await expectCopied(button, false);
}

await withBrowser(
	async (page) => {
		await open(page);
		const button = page.locator(BUTTON);
		const box = await button.boundingBox();
		assert.equal(box.width, 32);
		assert.equal(box.height, 32);
		const glyph = await button.locator(".icon-copy").evaluate((svg) => {
			const rect = svg.getBoundingClientRect();
			return {
				width: rect.width,
				height: rect.height,
				paths: svg.querySelectorAll("path").length,
				stroke: getComputedStyle(svg).stroke,
			};
		});
		assert.equal(glyph.width, 16);
		assert.equal(glyph.height, 16);
		assert.ok(glyph.paths > 0);
		assert.notEqual(glyph.stroke, "none");
		await expectCopied(button, false);

		// Edge considers file:// secure; remove the API to force the real fallback.
		await page.evaluate(() =>
			Object.defineProperty(navigator, "clipboard", {
				value: undefined,
				configurable: true,
			}),
		);
		await button.click();
		await expectCopied(button);
		assert.equal(
			await page.locator("textarea").count(),
			0,
			"Native fallback removes scratch textarea",
		);
		assert.equal(
			await button.evaluate((element) => element === document.activeElement),
			true,
			"Native fallback restores button focus",
		);
		console.log(
			"Fallback: real execCommand succeeds, glyph draws 16x16, scratch and focus restored",
		);
	},
	{ preserveClipboard: true },
);

for (const outcome of ["false", "throw", "success"]) {
	await withBrowser(async (page) => {
		await page.addInitScript((outcome) => {
			window.copyAttempts = [];
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error("Clipboard permission denied");
					},
				},
			});
			document.execCommand = () => {
				window.copyAttempts.push(document.activeElement.value);
				if (outcome === "throw") throw new Error("Fallback failed");
				return outcome === "success";
			};
		}, outcome);
		await open(page);
		const button = page.locator(BUTTON);
		await button.click();
		if (outcome === "success") await expectCopied(button);
		else await expectFailure(button);
		assert.deepEqual(await page.evaluate(() => window.copyAttempts), [
			"pnpm petri digest",
		]);
		assert.equal(
			await page.locator("textarea").count(),
			0,
			`${outcome} fallback cleans scratch textarea`,
		);
		assert.equal(
			await button.evaluate((element) => element === document.activeElement),
			true,
			`${outcome} fallback restores focus`,
		);
		console.log(
			`Clipboard rejection -> fallback ${outcome}: correct feedback, cleanup and focus`,
		);
	});
}

await withBrowser(async (page) => {
	await page.addInitScript(() => {
		window.copyAttempts = 0;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					window.copyAttempts++;
				},
			},
		});
		document.execCommand = () => {
			window.copyAttempts++;
			return true;
		};
	});
	await open(page);
	await page
		.locator('[data-fork-out="he-08"]')
		.evaluate((element) => element.remove());
	const button = page.locator(FORK);
	await button.click();
	await expectFailure(button);
	assert.equal(
		await page.evaluate(() => window.copyAttempts),
		0,
		"Missing output never copies empty or stale content",
	);
	console.log(
		"Missing fork output: failure announced, no clipboard write or success tick",
	);
});
