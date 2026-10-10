document.documentElement.classList.add("has-js");

const cards = document.querySelector("#tree-cards");
const detail = document.querySelector("#tree-detail");
const count = document.querySelector("#tree-count");
const status = document.querySelector("#tree-status");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

const score = (node) => node.score == null ? "—" : Number(node.score).toFixed(1);
const statusLabel = (value) => value ? value.replaceAll("_", " ") : "pending";

function nodeTree(nodes, compact = false) {
  const byParent = new Map();
  for (const node of nodes) {
    const children = byParent.get(node.parent_id) ?? [];
    children.push(node);
    byParent.set(node.parent_id, children);
  }
  const roots = byParent.get(null) ?? nodes.filter((node) => !node.parent_id);
  const positions = new Map();
  let nextRow = 0;
  const visit = (node, depth) => {
    const children = byParent.get(node.id) ?? [];
    const childRows = children.map((child) => visit(child, depth + 1));
    const row = childRows.length ? (childRows[0] + childRows.at(-1)) / 2 : nextRow++;
    positions.set(node.id, { depth, row });
    return row;
  };
  roots.forEach((root) => visit(root, 0));
  const maxDepth = Math.max(0, ...[...positions.values()].map(({ depth }) => depth));
  const maxRow = Math.max(0, ...[...positions.values()].map(({ row }) => row));
  const width = Math.max(520, (maxDepth + 1) * (compact ? 95 : 220) + 50);
  const height = Math.max(compact ? 140 : 300, (maxRow + 1) * (compact ? 25 : 64) + 40);
  const col = compact ? 95 : 220;
  const row = compact ? 25 : 64;
  const point = (id) => {
    const position = positions.get(id);
    return { x: 25 + position.depth * col, y: 20 + position.row * row };
  };
  const edgeMarkup = nodes.filter((node) => node.parent_id && positions.has(node.parent_id)).map((node) => {
    const from = point(node.parent_id);
    const to = point(node.id);
    const middle = (from.x + to.x) / 2;
    return `<path class="h-edge ${node.status === "failed" ? "dead" : ""}" d="M${from.x} ${from.y} C${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}"/>`;
  }).join("");
  const nodeMarkup = nodes.filter((node) => positions.has(node.id)).map((node) => {
    const { x, y } = point(node.id);
    const failed = node.status === "failed";
    const label = compact ? "" : `<text class="h-hyp" x="${x + 14}" y="${y - 3}">${esc(node.rationale || node.id).slice(0, 30)}</text><text class="h-num" x="${x + 14}" y="${y + 14}">${esc(statusLabel(node.status))} · ${esc(score(node))}</text>`;
    return `<g class="h-node" tabindex="0" role="button" data-node-id="${esc(node.id)}" aria-label="${esc(node.rationale || node.id)}"><circle class="${failed ? "g-hollow g-fail" : "g-pass"}" cx="${x}" cy="${y}" r="${compact ? 5 : 8}"/>${failed ? `<path class="g-x" d="M${x - 3} ${y - 3}L${x + 3} ${y + 3}M${x + 3} ${y - 3}L${x - 3} ${y + 3}"/>` : ""}${label}</g>`;
  }).join("");
  return `<svg class="${compact ? "mini" : "tree-svg"} viewBox="0 0 ${width} ${height}" role="img" aria-label="Tree with ${nodes.length} nodes">${edgeMarkup}${nodeMarkup}</svg>`;
}

function card(tree) {
  const best = tree.stats.best_score == null ? "—" : Number(tree.stats.best_score).toFixed(1);
  return `<li><button class="card tree-card" type="button" data-tree-id="${esc(tree.id)}"><div class="card-top"><div><p class="card-title">${esc(tree.name)}</p><p class="card-sub">${esc(tree.description || "Customer-support harness")}</p></div><span class="tag">${esc(tree.status)}</span></div><div class="card-mini">${nodeTree(tree.nodes, true)}</div><p class="card-goal">${esc(tree.benchmark?.name || "Benchmark pending")}</p><dl class="card-stats"><div><dt>Nodes</dt><dd>${tree.stats.node_count}</dd></div><div><dt>Complete</dt><dd>${tree.stats.complete_count}</dd></div><div><dt>Failed</dt><dd>${tree.stats.failed_count}</dd></div><div><dt>Best score</dt><dd>${esc(best)}</dd></div></dl></button></li>`;
}

function renderDetail(tree) {
  const root = tree.nodes.find((node) => node.id === tree.root_node_id) || tree.nodes[0];
  detail.hidden = false;
  detail.innerHTML = `<div class="section-head"><div><p class="eyebrow">Tree detail</p><h2 id="detail-heading">${esc(tree.name)}</h2></div><button class="detail-close" type="button">Close</button></div><p class="muted">${esc(tree.description || "No description provided.")}</p><div class="stage plate"><div class="tree-plate" tabindex="0">${nodeTree(tree.nodes)}</div><div class="legend"><span><i class="legend-dot pass"></i>Complete</span><span><i class="legend-dot wait"></i>Pending / running</span><span><i class="legend-dot fail"></i>Failed</span></div></div><article class="node-panel" aria-live="polite">${nodePanel(root)}</article>`;
  detail.querySelector(".detail-close").addEventListener("click", () => { detail.hidden = true; });
  detail.querySelectorAll("[data-node-id]").forEach((element) => {
    element.addEventListener("click", () => {
      const node = tree.nodes.find((candidate) => candidate.id === element.dataset.nodeId);
      detail.querySelector(".node-panel").innerHTML = nodePanel(node);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") element.click();
    });
  });
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function nodePanel(node) {
  if (!node) return "<p class=\"muted\">Select a node to inspect it.</p>";
  const harness = JSON.stringify(node.harness ?? {}, null, 2);
  return `<div class="node-panel-head"><div><p class="eyebrow">Selected node</p><h3>${esc(node.rationale || node.id)}</h3></div><span class="tag status-${esc(node.status)}">${esc(statusLabel(node.status))}</span></div><dl class="node-facts"><div><dt>Node ID</dt><dd><code>${esc(node.id)}</code></dd></div><div><dt>Score</dt><dd>${esc(score(node))}</dd></div><div><dt>Parent</dt><dd><code>${esc(node.parent_id || "Root")}</code></dd></div></dl>${node.error ? `<p class="error-copy">${esc(JSON.stringify(node.error))}</p>` : ""}<details><summary>Harness configuration</summary><pre><code>${esc(harness)}</code></pre></details>${node.benchmark_result ? `<details><summary>Benchmark result</summary><pre><code>${esc(JSON.stringify(node.benchmark_result, null, 2))}</code></pre></details>` : ""}`;
}

async function loadTrees() {
  try {
    const response = await fetch("/api/v1/trees");
    if (!response.ok) throw new Error(`Tree API returned ${response.status}`);
    const payload = await response.json();
    const trees = payload.data ?? [];
    count.textContent = `${trees.length} tree${trees.length === 1 ? "" : "s"}`;
    status.hidden = trees.length > 0;
    cards.innerHTML = trees.length ? trees.map(card).join("") : `<li class="empty-state"><h2>No trees yet</h2><p>Create a session and evaluate its root node to see it here.</p></li>`;
    cards.querySelectorAll("[data-tree-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const tree = trees.find((candidate) => candidate.id === button.dataset.treeId);
        renderDetail(tree);
      });
    });
  } catch (error) {
    count.textContent = "Unable to load trees";
    status.textContent = `Could not load tree data. ${error.message}`;
    status.classList.add("notice-error");
  }
}

loadTrees();
