// Test production HTML/API boundaries with local fixtures; never connect to Neon.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { assert, withBrowser } from "./browser.mjs";

const shell = await readFile(new URL("../../../app/templates/index.html", import.meta.url), "utf8");
const detailShell = await readFile(
  new URL("../../../app/templates/tree.html", import.meta.url),
  "utf8",
);
const node = (id, parent, status, score, extra = {}) => ({
  id,
  tree_id: "tree-1",
  parent_id: parent,
  status,
  score,
  harness: { system_prompt: "Help the customer <safely> & honestly." },
  rationale: `Version ${id}`,
  benchmark_result: null,
  error: null,
  ...extra,
});
const fixture = {
  id: "tree-1",
  name: "Customer support optimization",
  description: "Live backend contract",
  root_node_id: "root-node",
  status: "active",
  benchmark: { id: "bench-1", name: "Support cases", version: 1, scenarios: [] },
  nodes: [
    node("root-node", null, "complete", 0, {
      benchmark_result: {
        score: 0,
        scenarios: [
          {
            name: "Refund outside policy",
            passed: true,
            expected_action: "decline",
            actual_action: "decline",
          },
          {
            name: "Escalate damaged order",
            passed: false,
            expected_action: "escalate",
            actual_action: "refund",
            reason: "Refund exceeds authority",
          },
          { name: "Check follow-up", passed: null, reason: "Scenario timed out" },
        ],
      },
    }),
    node("better-node", "root-node", "complete", 87.5),
    node("queued-node", "root-node", "pending", null),
    node("running-node", "better-node", "running", null),
    node("failed-node", "queued-node", "failed", null, {
      rationale: 'Failure <img src=x onerror="window.injected=true"> & diagnosis',
      error: { message: "Evaluation failed <script>bad()</script>" },
      benchmark_result: { scenarios: [{ name: "refund", passed: false }] },
    }),
  ],
  stats: { node_count: 5, complete_count: 2, failed_count: 1, best_score: 87.5 },
};
const success = (body) => ({ status: 200, body });
let listResponse = success({ data: [fixture], total: 1 });
let detailResponse = success(fixture);
const requests = [];
const serverErrors = [];
const escapeAttribute = (text) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const server = createServer(async (request, result) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/v1/trees")) {
      requests.push({ url: pathname, method: request.method });
      const response = pathname === "/api/v1/trees" ? listResponse : detailResponse;
      result.writeHead(response.status, { "Content-Type": "application/json" });
      result.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
      return;
    }
    if (pathname === "/") {
      result.writeHead(200, { "Content-Type": "text/html" });
      result.end(shell);
      return;
    }
    const detailRoute = /^\/tree\/([^/]+)$/.exec(pathname);
    if (detailRoute) {
      // The browser fixture substitutes the two escaped Jinja values used by read_tree_page.
      const id = decodeURIComponent(detailRoute[1]);
      const html = detailShell
        .replaceAll("{{ tree_id }}", escapeAttribute(id))
        .replaceAll("{{ tree_api_url }}", `/api/v1/trees/${encodeURIComponent(id)}`);
      result.writeHead(200, { "Content-Type": "text/html" });
      result.end(html);
      return;
    }
    const asset = /^\/trees\/([a-z0-9-]+\.(?:css|js))$/.exec(pathname);
    if (asset) {
      result.writeHead(200, {
        "Content-Type": asset[1].endsWith("css") ? "text/css" : "text/javascript",
      });
      result.end(await readFile(new URL(`../${asset[1]}`, import.meta.url)));
      return;
    }
    result.writeHead(404);
    result.end();
  } catch (error) {
    serverErrors.push(error.message);
    result.writeHead(500);
    result.end("Fixture server failed");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function waitForLoad(page, content) {
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return element?.getAttribute("aria-busy") === "false";
  }, content);
}
async function assertFailure(page, message) {
  await page.waitForFunction(() =>
    document.querySelector("#tree-status").classList.contains("notice-error"),
  );
  assert.ok((await page.locator("#tree-status").textContent()).includes(message));
  assert.equal(await page.locator("#tree-status").isVisible(), true);
}

try {
  await withBrowser(
    async (page) => {
      await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator("a.tree-card").waitFor();
      const card = page.getByRole("link", { name: /Customer support optimization/ });
      assert.equal(await card.getAttribute("href"), "/tree/tree-1");
      assert.equal(await page.locator("#tree-count").textContent(), "1 tree");
      assert.equal(
        await page.locator("#tree-detail").count(),
        0,
        "Gallery has no inline detail section",
      );
      assert.equal(await page.locator(".live-stat-value").last().textContent(), "87.5");
      assert.equal(
        await page.locator(".tree-card .live-node").count(),
        0,
        "Mini tree is decorative",
      );
      const initialDocument = await page.evaluate(() => performance.timeOrigin);
      await card.click();
      await page.waitForURL(`${origin}/tree/tree-1`);
      await page.locator("#live-node").waitFor();
      assert.notEqual(
        await page.evaluate(() => performance.timeOrigin),
        initialDocument,
        "Card opens a different HTML page",
      );
      assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), fixture.name);
      assert.equal(await page.title(), `${fixture.name} · Harness trees`);
      assert.equal(
        await page.locator("#tree-cards").count(),
        0,
        "Detail page is separate from gallery",
      );
      assert.deepEqual(
        requests.slice(0, 2).map((request) => request.url),
        ["/api/v1/trees", "/api/v1/trees/tree-1"],
      );
      assert.equal(await page.locator(".live-node").count(), 5);
      const treePlate = page.locator(".tree-plate");
      const layout = await treePlate.evaluate((plate) => {
        const plateRect = plate.getBoundingClientRect();
        const nodes = [...plate.querySelectorAll("a.live-node > circle:first-child")].map((node) =>
          node.getBoundingClientRect(),
        );
        return {
          center:
            (Math.min(...nodes.map((node) => node.top)) +
              Math.max(...nodes.map((node) => node.bottom))) /
            2,
          plateCenter: (plateRect.top + plateRect.bottom) / 2,
        };
      });
      assert.ok(
        Math.abs(layout.center - layout.plateCenter) <= 8,
        `Sparse lineage centers vertically: ${JSON.stringify(layout)}`,
      );
      const renderedResults = page.locator(".benchmark-results");
      assert.equal(
        await renderedResults.count(),
        1,
        "Benchmark result uses a dedicated visual summary",
      );
      assert.equal(await renderedResults.locator(".scenario-result").count(), 3);
      assert.equal(await renderedResults.locator(".scenario-status-passed").count(), 1);
      assert.equal(await renderedResults.locator(".scenario-status-failed").count(), 1);
      assert.equal(await renderedResults.locator(".scenario-status-unknown").count(), 1);
      assert.ok((await renderedResults.innerText()).includes("Refund exceeds authority"));
      assert.ok((await renderedResults.innerText()).includes("1 unscored"));
      assert.equal(
        await renderedResults.locator("pre, code").count(),
        0,
        "Benchmark result is not dumped as JSON",
      );
      assert.ok(
        (await page.locator("#live-node").textContent()).includes("0.0"),
        "Zero score is not missing",
      );
      for (const [id, glyph] of [
        ["queued-node", "g-wait"],
        ["running-node", "g-wait"],
        ["failed-node", "g-fail"],
        ["better-node", "g-pass"],
      ]) {
        assert.equal(await page.locator(`a[data-node-id="${id}"] .${glyph}`).count(), 1);
      }
      await page.locator('a[data-node-id="failed-node"] text').first().click();
      await page.getByText("Harness configuration", { exact: true }).click();
      const harnessCopy = page.getByRole("button", {
        name: "Copy harness configuration",
        exact: true,
      });
      assert.equal(await harnessCopy.count(), 1, "Harness configuration has a copy control");
      await harnessCopy.click();
      await page.getByText("Copied to clipboard", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        '{\r\n  "system_prompt": "Help the customer <safely> & honestly."\r\n}',
        "Copy returns raw harness JSON, not escaped display markup",
      );
      await page.locator('a[data-node-id="root-node"] text').first().click();
      const resultCopy = page.getByRole("button", { name: "Copy benchmark result", exact: true });
      assert.equal(await resultCopy.count(), 1, "Benchmark summary has a copy control");
      await resultCopy.click();
      await page.getByText("Copied to clipboard", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        JSON.stringify(fixture.nodes[0].benchmark_result, null, 2).replaceAll("\n", "\r\n"),
        "Result copy preserves the API payload",
      );
      assert.equal(await page.locator("#live-node .status-complete").textContent(), "complete");
      await page.locator('a[data-node-id="failed-node"] text').first().click();
      assert.equal(await page.locator("#live-node .status-failed").textContent(), "failed");
      assert.ok((await page.locator("#live-node").textContent()).includes("Evaluation failed"));
      assert.equal(await page.locator("#live-node img, #live-node script").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.getByText("Harness configuration", { exact: true }).click();
      assert.ok(
        (await page.locator("#live-node pre").first().textContent()).includes(
          "<safely> & honestly",
        ),
      );
      await page.locator('a[data-node-id="queued-node"]').focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .locator('a[data-node-id="queued-node"]')
          .evaluate((link) => link === document.activeElement),
        true,
      );
      assert.equal(await page.locator("#live-node .status-pending").textContent(), "pending");
      const dropdownProbe = await page.context().newPage();
      await dropdownProbe.goto(
        `file://${new URL("../research--hermes-agent--claude-sonnet-5.html", import.meta.url).pathname}`,
      );
      const dropdown = dropdownProbe.locator('select[data-fork="he-08"]');
      await dropdown.hover();
      const dropdownHover = await dropdown.evaluate((element) => ({
        cursor: getComputedStyle(element).cursor,
        border: getComputedStyle(element).borderTopColor,
        primary: getComputedStyle(document.documentElement)
          .getPropertyValue("--md-sys-color-primary")
          .trim(),
      }));
      assert.equal(dropdownHover.cursor, "pointer", "Direction dropdown shows pointer cursor");
      assert.equal(
        dropdownHover.border,
        "rgb(168, 199, 250)",
        "Hover highlights the dropdown border",
      );
      for (const width of [360, 390, 700, 1020, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          ),
          false,
          `No detail-page overflow at ${width}`,
        );
      }
      if (process.env.INTEGRATION_SCREENSHOT) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('a[data-node-id="root-node"] text').first().click();
        await page.screenshot({ path: process.env.INTEGRATION_SCREENSHOT });
      }
      await page.getByRole("link", { name: "Back to trees", exact: true }).click();
      await page.waitForURL(`${origin}/`);
      await page.locator("a.tree-card").waitFor();
      await page.goBack();
      await page.locator("#live-node").waitFor();
      assert.equal(
        new URL(page.url()).pathname,
        "/tree/tree-1",
        "Browser Back preserves real page navigation",
      );

      const listRequests = requests.filter((request) => request.url === "/api/v1/trees").length;
      await page.goto(`${origin}/tree/tree-1`, { waitUntil: "domcontentloaded" });
      await page.locator("#live-node").waitFor();
      assert.equal(
        requests.filter((request) => request.url === "/api/v1/trees").length,
        listRequests,
        "Direct detail link needs no gallery request",
      );
      console.log(
        "Dedicated detail page: native card link, direct link, Back, single-tree API, node records, keyboard and six widths passed",
      );

      listResponse = success({ data: [], total: 0 });
      await page.goto(origin);
      await page.locator(".empty-state").waitFor();
      assert.equal(await page.locator("#tree-count").textContent(), "0 trees");
      for (const failure of [
        { status: 503, body: {}, expected: "503" },
        { status: 200, body: "not json", expected: "Could not load" },
        { status: 200, body: {}, expected: "invalid list" },
        { status: 200, body: { data: [fixture, fixture] }, expected: "duplicate trees" },
      ]) {
        listResponse = failure;
        await page.reload();
        await assertFailure(page, failure.expected);
        await waitForLoad(page, "#tree-cards");
      }
      listResponse = success({ data: [fixture], total: 1 });
      const documentBeforeRetry = await page.evaluate(() => performance.timeOrigin);
      await page.getByRole("button", { name: "Retry loading trees", exact: true }).click();
      await page.locator("a.tree-card").waitFor();
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentBeforeRetry);
      assert.equal(await page.locator("#tree-status").isVisible(), false);

      detailResponse = success({ ...fixture, nodes: [], root_node_id: null });
      await page.goto(`${origin}/tree/tree-1`);
      await page.locator("#live-node").waitFor();
      assert.ok((await page.locator("#live-node").textContent()).includes("no nodes"));
      const cycle = [
        { ...fixture.nodes[0], parent_id: "better-node" },
        { ...fixture.nodes[1], parent_id: "root-node" },
      ];
      for (const failure of [
        { status: 404, body: {}, expected: "Tree not found" },
        { status: 503, body: {}, expected: "503" },
        { status: 200, body: { ...fixture, id: "wrong-tree" }, expected: "different tree" },
        { status: 200, body: { ...fixture, nodes: cycle }, expected: "cycle" },
        {
          status: 200,
          body: { ...fixture, nodes: [fixture.nodes[0], fixture.nodes[0]] },
          expected: "duplicate node",
        },
      ]) {
        detailResponse = failure;
        await page.reload();
        await assertFailure(page, failure.expected);
        await waitForLoad(page, "#tree-detail");
        assert.equal(await page.locator("#tree-detail").isVisible(), false);
      }
      detailResponse = success(fixture);
      const detailDocument = await page.evaluate(() => performance.timeOrigin);
      await page.getByRole("button", { name: "Retry loading trees", exact: true }).click();
      await page.locator("#live-node").waitFor();
      assert.equal(await page.evaluate(() => performance.timeOrigin), detailDocument);
      assert.equal(await page.locator("#tree-status").isVisible(), false);
      assert.equal(
        await page.getByRole("button", { name: "Retry loading trees", exact: true }).isVisible(),
        false,
      );
      assert.ok(
        requests.every((request) => request.method === "GET"),
        "Only read-only API requests",
      );
      console.log(
        "Gallery/detail failures: empty nodes, invalid data, 404, 503, cycles and retry without reload passed",
      );
    },
    { permissions: ["clipboard-read", "clipboard-write"], preserveClipboard: true },
  );
  await withBrowser(async (page) => {
    const showcase = new URL("../research--hermes-agent--claude-sonnet-5.html", import.meta.url);
    await page.goto(showcase.href, { waitUntil: "domcontentloaded" });
    const dropdown = page.locator('select[data-fork="he-08"]');
    await dropdown.waitFor({ state: "visible" });
    assert.equal(await dropdown.evaluate((element) => getComputedStyle(element).cursor), "pointer");
    console.log("Showcase direction dropdown: hover cursor is pointer");
  });
  await withBrowser(
    async (page) => {
      const before = requests.length;
      for (const path of ["/", "/tree/tree-1"]) {
        await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
        assert.equal(await page.locator("noscript").isVisible(), true);
        assert.equal(await page.locator("noscript a").count(), 2);
      }
      assert.equal(requests.length, before, "No API requests without JavaScript");
      assert.equal(
        await page.getByRole("link", { name: "Back to trees", exact: true }).isVisible(),
        true,
      );
      console.log("No-JS: both HTML pages keep native navigation and truthful API/docs fallback");
    },
    { javaScriptEnabled: false },
  );
  assert.deepEqual(serverErrors, []);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
