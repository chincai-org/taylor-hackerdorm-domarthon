import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assert,
	expectCopied,
	open,
	shotPath,
	withBrowser,
} from "./browser.mjs";

// Keep the original reference screenshots intact; new captures stay in the project.
await mkdir(dirname(shotPath("1-gallery.png")), { recursive: true });
await withBrowser(
	async (page) => {
		await open(page, "index");
		await page.screenshot({ path: shotPath("1-gallery.png") });
		await open(page);
		await page.screenshot({ path: shotPath("2-tree.png") });
		await page
			.locator('.selected-strip[data-for="he-08"] a[href="#s-he-08"]')
			.click();
		assert.ok(
			await page.evaluate(() => window.scrollY > 0),
			"Record screenshot shows an actual anchor scroll",
		);
		await page.screenshot({ path: shotPath("3-record.png") });
		await page.locator('label[for="view-stats"]').click();
		await page.locator(".view-stats").waitFor({ state: "visible" });
		await page.screenshot({ path: shotPath("4-stats.png") });
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page);
		await page.screenshot({ path: shotPath("5-mobile.png") });
		await page.setViewportSize({ width: 1440, height: 900 });
		await open(page);

		const literal = page.locator(
			'.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]',
		);
		const row = literal.locator("..");
		await row.screenshot({ path: shotPath("6-copy-icon.png") });
		await literal.hover();
		await row.screenshot({ path: shotPath("7-copy-icon-hover.png") });
		await literal.click();
		await expectCopied(literal);
		await row.screenshot({ path: shotPath("8-copy-done.png") });

		const fork = page.locator('.rec[data-for="he-08"] .np-block.fork');
		await fork.screenshot({ path: shotPath("9-fork-box.png") });
		const forkButton = fork.locator("button.copy");
		await forkButton.click();
		await expectCopied(forkButton);
		await fork.screenshot({ path: shotPath("10-fork-copied.png") });
		await page
			.locator('.rec[data-for="he-08"] .np-block.checkit')
			.screenshot({ path: shotPath("11-checkit-box.png") });
		console.log("Screenshots captured in", dirname(shotPath("1-gallery.png")));
	},
	{
		permissions: ["clipboard-read", "clipboard-write"],
		preserveClipboard: true,
	},
);
