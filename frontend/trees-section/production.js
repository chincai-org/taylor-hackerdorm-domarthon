/** Live FastAPI viewer restored from commit 54019be; separate from the Petri showcase. */
(() => {
  const cards = document.getElementById("tree-cards");
  const detail = document.getElementById("tree-detail");
  const count = document.getElementById("tree-count");
  const status = document.getElementById("tree-status");
  const retry = document.getElementById("tree-retry");
  const content = cards ?? detail;
  if (!content || !status || !retry) return;

  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const score = (value) => (value === null || value === undefined ? "—" : value.toFixed(1));
  const labelOf = (node) => node.rationale || node.id;
  const statuses = new Set(["pending", "running", "complete", "failed"]);
  let trees = new Map();
  let selectedTree = null;

  /** Validate the backend's contract, not the showcase's acceptance/basis-point schema. */
  function prepareTree(tree) {
    if (
      !tree ||
      typeof tree.id !== "string" ||
      typeof tree.name !== "string" ||
      !Array.isArray(tree.nodes)
    ) {
      throw new Error("Tree API returned an invalid tree.");
    }
    const nodes = new Map();
    for (const node of tree.nodes) {
      if (
        !node ||
        typeof node.id !== "string" ||
        nodes.has(node.id) ||
        !statuses.has(node.status) ||
        (node.parent_id !== null && typeof node.parent_id !== "string") ||
        (node.score !== null && (typeof node.score !== "number" || !Number.isFinite(node.score)))
      ) {
        throw new Error("Tree API returned an invalid or duplicate node.");
      }
      nodes.set(node.id, node);
    }
    const children = new Map();
    const roots = [];
    for (const node of nodes.values()) {
      // Missing parents are roots in a partial export; disconnected cycles are errors.
      if (node.parent_id === null || !nodes.has(node.parent_id)) roots.push(node.id);
      else {
        const siblings = children.get(node.parent_id) ?? [];
        siblings.push(node.id);
        children.set(node.parent_id, siblings);
      }
    }
    const slots = new Map();
    const visited = new Set();
    let nextRow = 0;
    const work = roots.toReversed().map((id) => ({ id, depth: 0, expanded: false }));
    while (work.length) {
      const { id, depth, expanded } = work.pop();
      const descendants = children.get(id) ?? [];
      if (expanded) {
        const row = descendants.length
          ? (slots.get(descendants[0]).row + slots.get(descendants.at(-1)).row) / 2
          : nextRow++;
        slots.set(id, { depth, row });
        continue;
      }
      if (visited.has(id)) throw new Error("Tree API returned a parent cycle.");
      visited.add(id);
      work.push({ id, depth, expanded: true });
      for (const child of descendants.toReversed())
        work.push({ id: child, depth: depth + 1, expanded: false });
    }
    if (visited.size !== nodes.size)
      throw new Error("Tree API returned a disconnected parent cycle.");
    const stats = { node_count: nodes.size, complete_count: 0, failed_count: 0, best_score: null };
    for (const node of nodes.values()) {
      if (node.status === "complete") stats.complete_count++;
      if (node.status === "failed") stats.failed_count++;
      if (node.score !== null)
        stats.best_score =
          stats.best_score === null ? node.score : Math.max(stats.best_score, node.score);
    }
    const bounds = { depth: 0, row: 0 };
    for (const slot of slots.values()) {
      bounds.depth = Math.max(bounds.depth, slot.depth);
      bounds.row = Math.max(bounds.row, slot.row);
    }
    return { ...tree, nodeMap: nodes, slots, bounds, stats };
  }

  function glyph(node, x, y, radius) {
    if (node.status === "complete")
      return `<circle class="g-pass" cx="${x}" cy="${y}" r="${radius}"/>`;
    const failed = node.status === "failed";
    return (
      `<circle class="g-hollow ${failed ? "g-fail" : "g-wait"}" cx="${x}" cy="${y}" r="${radius}"/>` +
      (failed
        ? `<path class="g-x" d="M${x - 3} ${y - 3}L${x + 3} ${y + 3}M${x + 3} ${y - 3}L${x - 3} ${y + 3}"/>`
        : `<circle class="g-dot" cx="${x}" cy="${y}" r="${radius * 0.28}"/>`)
    );
  }

  function nodeTree(tree, compact = false) {
    const columnGap = compact ? 95 : 220;
    const rowGap = compact ? 25 : 64;
    const width = Math.max(520, (tree.bounds.depth + 1) * columnGap + 50);
    const height = Math.max(compact ? 140 : 300, (tree.bounds.row + 1) * rowGap + 40);
    const point = (id) => {
      const slot = tree.slots.get(id);
      return { x: 25 + slot.depth * columnGap, y: 20 + slot.row * rowGap };
    };
    const edges = tree.nodes
      .filter((node) => tree.slots.has(node.parent_id))
      .map((node) => {
        const from = point(node.parent_id);
        const to = point(node.id);
        const middle = (from.x + to.x) / 2;
        return `<path class="h-edge${node.status === "failed" ? " dead" : ""}" d="M${from.x} ${from.y}C${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}"/>`;
      })
      .join("");
    const nodes = tree.nodes
      .map((node) => {
        const { x, y } = point(node.id);
        const drawing = glyph(node, x, y, compact ? 5 : 8);
        if (compact) return drawing;
        const label = labelOf(node);
        // Truncate the raw text before escaping so entities cannot be cut in half.
        return `<a class="live-node" href="#live-node" data-node-id="${escape(node.id)}" aria-label="${escape(`${label}: ${node.status}, score ${score(node.score)}`)}">${drawing}<text class="h-hyp" x="${x + 14}" y="${y - 3}">${escape(label.slice(0, 30))}</text><text class="h-num" x="${x + 14}" y="${y + 14}">${escape(node.status)} · ${score(node.score)}</text></a>`;
      })
      .join("");
    return `<svg class="${compact ? "mini" : "tree-svg"}" viewBox="0 0 ${width} ${height}" ${compact ? 'aria-hidden="true"' : 'role="group" aria-label="Harness version lineage"'}>${edges}${nodes}</svg>`;
  }

  function card(tree) {
    const stats = tree.stats;
    return `<li><a class="card tree-card" href="/tree/${escape(encodeURIComponent(tree.id))}"><span class="card-top"><span><span class="card-title">${escape(tree.name)}</span><span class="card-sub">${escape(tree.description || "Customer-support harness")}</span></span><span class="tag">${escape(tree.status)}</span></span><span class="card-mini">${nodeTree(tree, true)}</span><span class="card-goal">${escape(tree.benchmark?.name || "Benchmark pending")}</span><span class="card-stats">${[
      ["Nodes", stats.node_count],
      ["Complete", stats.complete_count],
      ["Failed", stats.failed_count],
      ["Best score", score(stats.best_score)],
    ]
      .map(
        ([label, value]) =>
          `<span><span class="live-stat-label">${label}</span><span class="live-stat-value">${escape(value)}</span></span>`,
      )
      .join("")}</span></a></li>`;
  }

  function nodePanel(node) {
    if (!node) return '<p class="muted">This tree has no nodes yet.</p>';
    const json = (value) => escape(JSON.stringify(value, null, 2));
    return `<div class="node-panel-head"><div><p class="eyebrow">Selected node</p><h3 id="live-node-heading" tabindex="-1">${escape(labelOf(node))}</h3></div><span class="tag status-${node.status}">${escape(node.status)}</span></div><dl class="node-facts"><div><dt>Node ID</dt><dd><code>${escape(node.id)}</code></dd></div><div><dt>Score</dt><dd>${score(node.score)}</dd></div><div><dt>Parent</dt><dd><code>${escape(node.parent_id || "Root")}</code></dd></div></dl>${node.error !== null && node.error !== undefined ? `<p class="error-copy">${json(node.error)}</p>` : ""}<details><summary>Harness configuration</summary><pre><code>${json(node.harness ?? {})}</code></pre></details>${node.benchmark_result !== null && node.benchmark_result !== undefined ? `<details><summary>Benchmark result</summary><pre><code>${json(node.benchmark_result)}</code></pre></details>` : ""}`;
  }

  function selectNode(node) {
    const panel = detail.querySelector(".node-panel");
    panel.innerHTML = nodePanel(node);
    for (const link of detail.querySelectorAll("[data-node-id]")) {
      if (link.dataset.nodeId === node?.id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  function renderDetail(tree) {
    selectedTree = tree;
    document.getElementById("detail-heading").textContent = tree.name;
    document.title = `${tree.name} · Harness trees`;
    detail.hidden = false;
    detail.innerHTML = `<p class="muted">${escape(tree.description || "No description provided.")}</p><div class="stage plate"><section class="tree-plate" tabindex="0" aria-label="Scrollable harness tree">${nodeTree(tree)}</section><div class="legend" role="group" aria-label="Node status"><span><i class="legend-dot pass" aria-hidden="true"></i>Complete</span><span><i class="legend-dot wait" aria-hidden="true"></i>Pending / running</span><span><i class="legend-dot fail" aria-hidden="true"></i>Failed</span></div></div><article id="live-node" class="node-panel" aria-live="polite"></article>`;
    selectNode(tree.nodeMap.get(tree.root_node_id) ?? tree.nodes[0]);
  }

  detail?.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-node-id]");
    if (
      !link ||
      !selectedTree ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    selectNode(selectedTree.nodeMap.get(link.dataset.nodeId));
    // The live region announces the new record; focus stays in the tree for traversal.
    link.focus({ preventScroll: true });
  });

  async function loadTrees() {
    if (content.getAttribute("aria-busy") === "true") return;
    retry.hidden = true;
    retry.disabled = true;
    if (count) count.textContent = "Loading trees…";
    status.hidden = false;
    status.classList.remove("notice-error");
    status.textContent = "Loading tree data…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    content.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(
        content.dataset.treeUrl ?? content.dataset.treesUrl ?? "/api/v1/trees",
        {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404 ? "Tree not found." : `Tree API returned ${response.status}`,
        );
      const payload = await response.json();
      if (cards) {
        if (!Array.isArray(payload?.data)) throw new Error("Tree API returned an invalid list.");
        const prepared = payload.data.map(prepareTree);
        trees = new Map(prepared.map((tree) => [tree.id, tree]));
        if (trees.size !== prepared.length) throw new Error("Tree API returned duplicate trees.");
        count.textContent = `${trees.size} tree${trees.size === 1 ? "" : "s"}`;
        cards.innerHTML = prepared.length
          ? prepared.map(card).join("")
          : '<li class="empty-state"><h2>No trees yet</h2><p>Create a session and evaluate its root node to see it here.</p></li>';
      } else {
        const tree = prepareTree(payload);
        if (tree.id !== detail.dataset.treeId)
          throw new Error("Tree API returned a different tree.");
        renderDetail(tree);
      }
      status.hidden = true;
    } catch (error) {
      if (count) count.textContent = "Unable to load trees";
      status.hidden = false;
      status.classList.add("notice-error");
      retry.hidden = false;
      status.textContent = `Could not load tree data. ${error.name === "AbortError" ? "The request timed out." : error.message}`;
    } finally {
      clearTimeout(timer);
      content.setAttribute("aria-busy", "false");
      retry.disabled = false;
    }
  }

  retry.addEventListener("click", loadTrees);
  loadTrees();
})();
