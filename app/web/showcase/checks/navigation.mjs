import { assert, expectSelection, open, withBrowser } from "./browser.mjs";

for (const javaScriptEnabled of [true, false]) {
	await withBrowser(
		async (page) => {
			await open(page, undefined, "#s-he-02");
			await expectSelection(page, "he-02");
			await page.evaluate(() => {
				location.hash = "#s-he-07";
			});
			await page.waitForURL("**#s-he-07", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-07");
			await page.evaluate(() => {
				location.hash = "#s-he-03";
			});
			await page.waitForURL("**#s-he-03", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-03");

			await page.goBack({ waitUntil: "domcontentloaded" });
			await page.waitForURL("**#s-he-07", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-07");
			await page.goBack({ waitUntil: "domcontentloaded" });
			await page.waitForURL("**#s-he-02", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-02");
			await page.goForward({ waitUntil: "domcontentloaded" });
			await page.waitForURL("**#s-he-07", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-07");
			await page.goForward({ waitUntil: "domcontentloaded" });
			await page.waitForURL("**#s-he-03", { waitUntil: "domcontentloaded" });
			await expectSelection(page, "he-03");

			await page.evaluate(() => {
				location.hash = "#unknown-version";
			});
			await page.waitForURL("**#unknown-version", {
				waitUntil: "domcontentloaded",
			});
			await expectSelection(page, "he-08");
			await page.evaluate(() => {
				location.hash = "";
			});
			await page.waitForURL((url) => url.hash === "", {
				waitUntil: "domcontentloaded",
			});
			await expectSelection(page, "he-08");

			// Enhancement preserves normal modified-click semantics without changing selection.
			if (javaScriptEnabled) {
				const prevented = await page
					.locator('.h-node[href="#s-he-07"]')
					.evaluate((link) => {
						const event = new MouseEvent("click", {
							bubbles: true,
							cancelable: true,
							ctrlKey: true,
						});
						let intercepted;
						window.addEventListener(
							"click",
							(event) => {
								intercepted = event.defaultPrevented;
								event.preventDefault();
							},
							{ once: true },
						);
						link.dispatchEvent(event);
						return intercepted;
					});
				assert.equal(
					prevented,
					false,
					"Enhancement does not prevent a modified node click",
				);
				await expectSelection(page, "he-08");
			}
			console.log(
				`${javaScriptEnabled ? "JS-on" : "JS-off"}: deep links, hashchange, Back/Forward and unknown-fragment reset passed`,
			);
		},
		{ javaScriptEnabled },
	);
}
