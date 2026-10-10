import { assert, expectCopied, expectSelection, open, withBrowser } from "./browser.mjs";

const normalize = (value) => value.replace(/\r\n/g, "\n").trim();
const FORK = '.rec[data-for="he-08"] button.copy[data-copy-out="he-08"]';
const LITERAL = '.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]';

await withBrowser(
  async (page, browser) => {
    await open(page);
    await expectSelection(page, "he-08");
    assert.equal(await page.evaluate(() => typeof navigator.clipboard?.writeText), "function");
    const fork = page.locator(FORK);
    const initialLabel = await fork.getAttribute("aria-label");
    await expectCopied(fork, false);
    await fork.click();
    await expectCopied(fork);
    const expected = await page.locator('[data-fork-out="he-08"]').textContent();
    assert.equal(
      normalize(await page.evaluate(() => navigator.clipboard.readText())),
      normalize(expected),
    );
    assert.equal(
      await fork.evaluate((button) => button.nextElementSibling.textContent),
      "Copied to clipboard",
    );
    await expectCopied(fork, false);
    assert.equal(
      await fork.getAttribute("aria-label"),
      initialLabel,
      "Original label restored after success feedback",
    );

    const literal = page.locator(LITERAL);
    await literal.click();
    await expectCopied(literal);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "pnpm petri digest");

    await page.selectOption('select[data-fork="he-08"]', {
      label: "token savings",
    });
    await fork.click();
    await expectCopied(fork);
    const clipboard = normalize(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(clipboard, normalize(await page.locator('[data-fork-out="he-08"]').textContent()));
    assert.ok(clipboard.includes("--motif token-savings"));

    const context = await browser.newContext({
      javaScriptEnabled: false,
      colorScheme: "dark",
    });
    const noScript = await context.newPage();
    await open(noScript);
    assert.equal(
      await noScript.locator("button.copy:visible").count(),
      0,
      "No inert copy buttons without JavaScript",
    );
    assert.equal(
      await noScript.locator("select[data-fork]:visible").count(),
      0,
      "No inert direction picker without JavaScript",
    );
    assert.equal(
      await noScript.locator('.rec[data-for="he-08"] [data-fork-out]').isVisible(),
      true,
    );
    console.log(
      "Clipboard API: literal and rewritten commands copied, feedback resets, JS-off controls hidden",
    );
  },
  { permissions: ["clipboard-read", "clipboard-write"], preserveClipboard: true },
);
