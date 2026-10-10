/** Live FastAPI viewer: gallery + tree detail, driven by /api/v1/trees. */
(() => {
  // Gate script-only controls before anything else (live CSS hides them until set).
  document.documentElement.classList.add("has-js");
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
  const score = (value) =>
    value === null || value === undefined ? "—" : value.toFixed(1);
  const labelOf = (node) => node.rationale || node.id;
  // Cut at a word boundary + ellipsis; full text stays in <title>/aria-label.
  const shortLabel = (label) => {
    if (label.length <= 30) return label;
    const cut = label.slice(0, 29).lastIndexOf(" ");
    return `${label.slice(0, cut > 12 ? cut : 29)}…`;
  };
  const statuses = new Set(["pending", "running", "complete", "failed"]);
  let trees = new Map();
  let selectedTree = null;
  let selectedNodeId = null;
  let pollTimer = 0;
  let pollInflight = false;

  // Skeleton placeholders for the gallery. One markup helper so the create
  // flow and the initial load share the same structure/classes.
  const skeletonCard = () =>
    `<li class="skeleton-card" data-creating-skeleton aria-hidden="true">` +
    `<span class="skeleton-line skeleton-title"></span>` +
    `<span class="skeleton-line skeleton-sub"></span>` +
    `<span class="skeleton-block"></span>` +
    `<span class="skeleton-stats"><span></span><span></span><span></span><span></span></span>` +
    `</li>`;
  const showGallerySkeletons = (count = 3) => {
    if (cards && cards.childElementCount === 0)
      cards.innerHTML = Array.from({ length: count }, skeletonCard).join("");
  };
  const prependCreatingSkeleton = () => {
    if (!cards) return;
    // Clear the empty-state row so the skeleton reads as incoming content.
    if (cards.querySelector(".empty-state")) cards.innerHTML = "";
    cards.insertAdjacentHTML("afterbegin", skeletonCard());
  };
  const clearCreatingSkeletons = () => {
    for (const node of document.querySelectorAll(
      "[data-creating-skeleton]",
    ))
      node.remove();
  };
  // Gallery create form posts JSON and refreshes the card list in place.
  // Without this the button falls back to a plain GET reload that creates nothing.
  const createForm = document.getElementById("tree-create-form");
  if (createForm) {
    const nameInput = document.getElementById("tree-name");
    const descInput = document.getElementById("tree-description");
    const submit = document.getElementById("tree-create-submit");
    const formStatus = document.getElementById("tree-create-status");
    const submitLabel = submit.textContent;
    const setFormStatus = (text, kind) => {
      formStatus.textContent = text;
      formStatus.classList.toggle("notice-error", kind === "error");
      formStatus.classList.toggle("notice-success", kind === "success");
    };
    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (createForm.getAttribute("aria-busy") === "true") return;
      setFormStatus("Creating tree…", null);
      submit.disabled = true;
      submit.textContent = "Creating…";
      createForm.setAttribute("aria-busy", "true");
      // Show the incoming card immediately: the POST evaluates the root
      // node, so the round-trip is slow and needs a placeholder.
      prependCreatingSkeleton();
      try {
        const response = await fetch(
          createForm.dataset.createUrl ?? "/api/v1/trees",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              name: nameInput.value,
              description: descInput.value || null,
            }),
          },
        );
        if (!response.ok) {
          let detail = `Tree API returned ${response.status}`;
          try {
            const problem = await response.json();
            if (typeof problem?.detail === "string") detail = problem.detail;
          } catch {
            // Non-JSON error body; keep the status text.
          }
          throw new Error(detail);
        }
        const tree = await response.json();
        createForm.reset();
        setFormStatus(`Tree "${tree.name}" created.`, "success");
        await loadTrees();
      } catch (error) {
        clearCreatingSkeletons();
        setFormStatus(`Could not create tree. ${error.message}`, "error");
      } finally {
        submit.disabled = false;
        submit.textContent = submitLabel;
        createForm.removeAttribute("aria-busy");
      }
    });
  }

  /** Validate the backend's tree/node contract before rendering. */
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
        (node.score !== null &&
          (typeof node.score !== "number" || !Number.isFinite(node.score)))
      ) {
        throw new Error("Tree API returned an invalid or duplicate node.");
      }
      nodes.set(node.id, node);
    }
    const children = new Map();
    const roots = [];
    for (const node of nodes.values()) {
      // Missing parents are roots in a partial export; disconnected cycles are errors.
      if (node.parent_id === null || !nodes.has(node.parent_id))
        roots.push(node.id);
      else {
        const siblings = children.get(node.parent_id) ?? [];
        siblings.push(node.id);
        children.set(node.parent_id, siblings);
      }
    }
    const slots = new Map();
    const visited = new Set();
    let nextRow = 0;
    const work = roots
      .toReversed()
      .map((id) => ({ id, depth: 0, expanded: false }));
    while (work.length) {
      const { id, depth, expanded } = work.pop();
      const descendants = children.get(id) ?? [];
      if (expanded) {
        const row = descendants.length
          ? (slots.get(descendants[0]).row +
              slots.get(descendants.at(-1)).row) /
            2
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
    const stats = {
      node_count: nodes.size,
      complete_count: 0,
      failed_count: 0,
      best_score: null,
    };
    for (const node of nodes.values()) {
      if (node.status === "complete") stats.complete_count++;
      if (node.status === "failed") stats.failed_count++;
      if (node.score !== null)
        stats.best_score =
          stats.best_score === null
            ? node.score
            : Math.max(stats.best_score, node.score);
    }
    const bounds = { depth: 0, firstRow: Infinity, lastRow: 0 };
    for (const slot of slots.values()) {
      bounds.depth = Math.max(bounds.depth, slot.depth);
      bounds.firstRow = Math.min(bounds.firstRow, slot.row);
      bounds.lastRow = Math.max(bounds.lastRow, slot.row);
    }
    if (slots.size === 0) bounds.firstRow = 0;
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
    const naturalHeight = (tree.bounds.lastRow + 1) * rowGap + 40;
    const height = Math.max(compact ? 140 : 300, naturalHeight);
    const rowCenter =
      20 + ((tree.bounds.firstRow + tree.bounds.lastRow) / 2) * rowGap;
    const verticalOffset = compact ? 0 : Math.max(0, height / 2 - rowCenter);
    const point = (id) => {
      const slot = tree.slots.get(id);
      return {
        x: 25 + slot.depth * columnGap,
        y: 20 + slot.row * rowGap + verticalOffset,
      };
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
        return `<a class="live-node" href="#live-node" data-node-id="${escape(node.id)}" aria-label="${escape(`${label}: ${node.status}, score ${score(node.score)}`)}"><title>${escape(label)}</title>${drawing}<text class="h-hyp" x="${x + 14}" y="${y - 3}">${escape(shortLabel(label))}</text><text class="h-num" x="${x + 14}" y="${y + 14}">${escape(node.status)} · ${score(node.score)}</text></a>`;
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

  function copyControl(nodeId, label) {
    return `<button class="live-copy" type="button" data-copy-node="${escape(nodeId)}" aria-label="Copy ${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/></svg><span>Copy</span></button><span class="live-copy-status" role="status" aria-live="polite"></span>`;
  }

  function harnessText(harness) {
    if (typeof harness === "string") return harness;
    if (harness === null || harness === undefined) return "";
    return JSON.stringify(harness, null, 2);
  }

  /** Build a line-oriented diff without requiring a client-side dependency. */
  function diffLines(beforeText, afterText) {
    const before = beforeText
      ? beforeText.replace(/\r\n?/g, "\n").split("\n")
      : [];
    const after = afterText
      ? afterText.replace(/\r\n?/g, "\n").split("\n")
      : [];
    const cells = before.length * after.length;
    if (beforeText === afterText) {
      return {
        ops: before.map((text) => ({ type: "context", text })),
        added: 0,
        deleted: 0,
        limited: false,
      };
    }

    // Avoid blocking the detail page on an unexpectedly huge prompt. The
    // fallback still makes every changed line explicit, just without context.
    if (cells > 2_000_000) {
      return {
        ops: [
          ...before.map((text) => ({ type: "delete", text })),
          ...after.map((text) => ({ type: "add", text })),
        ],
        added: after.length,
        deleted: before.length,
        limited: true,
      };
    }

    const lcs = Array.from(
      { length: before.length + 1 },
      () => new Uint32Array(after.length + 1),
    );
    for (let row = before.length - 1; row >= 0; row -= 1) {
      for (let column = after.length - 1; column >= 0; column -= 1) {
        lcs[row][column] =
          before[row] === after[column]
            ? lcs[row + 1][column + 1] + 1
            : Math.max(lcs[row + 1][column], lcs[row][column + 1]);
      }
    }

    const ops = [];
    let row = 0;
    let column = 0;
    let added = 0;
    let deleted = 0;
    while (row < before.length || column < after.length) {
      if (row < before.length && column < after.length && before[row] === after[column]) {
        ops.push({ type: "context", text: before[row] });
        row += 1;
        column += 1;
      } else if (
        row < before.length &&
        (column === after.length || lcs[row + 1][column] >= lcs[row][column + 1])
      ) {
        ops.push({ type: "delete", text: before[row] });
        deleted += 1;
        row += 1;
      } else {
        ops.push({ type: "add", text: after[column] });
        added += 1;
        column += 1;
      }
    }
    return { ops, added, deleted, limited: false };
  }

  function harnessDiff(node) {
    if (!node.parent_id) {
      return `<section class="harness-diff" aria-labelledby="harness-diff-heading"><header class="diff-header"><div><p class="eyebrow">Line comparison</p><h4 id="harness-diff-heading">Root harness</h4></div><span class="diff-summary">No parent</span></header><p class="muted">This is the root node, so it has no parent configuration to compare.</p></section>`;
    }
    const parent = selectedTree?.nodeMap.get(node.parent_id);
    if (!parent) {
      return `<section class="harness-diff" aria-labelledby="harness-diff-heading"><header class="diff-header"><div><p class="eyebrow">Line comparison</p><h4 id="harness-diff-heading">Changes from parent</h4></div></header><p class="muted">The parent node is not included in this tree response, so the comparison is unavailable.</p></section>`;
    }

    const result = diffLines(harnessText(parent.harness), harnessText(node.harness));
    const summary = result.added || result.deleted
      ? `<span class="diff-count-add">+${result.added} added</span><span class="diff-count-delete">-${result.deleted} deleted</span>`
      : "No line changes";
    let oldNumber = 0;
    let newNumber = 0;
    const lines = result.added || result.deleted
      ? result.ops
          .map((operation) => {
            const oldLabel = operation.type === "add" ? "" : String(++oldNumber);
            const newLabel = operation.type === "delete" ? "" : String(++newNumber);
            const lineLabel = operation.type === "delete" ? oldLabel : newLabel;
            const marker = operation.type === "add" ? "+" : operation.type === "delete" ? "-" : " ";
            return `<div class="diff-line diff-${operation.type}"><span class="diff-marker" aria-hidden="true">${marker}</span><span class="diff-number">${lineLabel}</span><code>${escape(operation.text)}</code></div>`;
          })
          .join("")
      : "";
    const body = result.added || result.deleted
      ? `<div class="diff-view" role="region" aria-label="Line changes from parent">${lines}</div>`
      : '<p class="muted">The child harness is identical to its parent.</p>';
    const note = result.limited
      ? '<p class="diff-note">This harness is large, so the comparison lists all parent lines as deleted and child lines as added.</p>'
      : "";
    return `<section class="harness-diff" aria-labelledby="harness-diff-heading"><header class="diff-header"><div><p class="eyebrow">Line comparison</p><h4 id="harness-diff-heading">Changes from parent</h4></div><span class="diff-summary">${summary}</span></header>${body}${note}</section>`;
  }

  function benchmarkResult(node) {
    const result = node.benchmark_result;
    if (!result || typeof result !== "object") return "";
    const scenarios = Array.isArray(result.scenarios) ? result.scenarios : null;
    if (scenarios) {
      const passed = scenarios.filter(
        (scenario) => scenario?.passed === true,
      ).length;
      const failed = scenarios.filter(
        (scenario) => scenario?.passed === false,
      ).length;
      const unscored = scenarios.length - passed - failed;
      const summary = `${passed} passed · ${failed} failed · ${unscored} unscored · ${scenarios.length} total`;
      const rows = scenarios
        .map((scenario, index) => {
          const state =
            scenario?.passed === true
              ? "passed"
              : scenario?.passed === false
                ? "failed"
                : "unknown";
          const name =
            scenario?.name ?? scenario?.scenario ?? `Scenario ${index + 1}`;
          const expected = scenario?.expected_action ?? scenario?.expected;
          const actual = scenario?.actual_action ?? scenario?.actual;
          const reason = scenario?.reason ?? scenario?.failure_reason;
          return `<li class="scenario-result scenario-status-${state}"><div class="scenario-heading"><strong>${escape(name)}</strong><span class="scenario-badge">${state === "unknown" ? "No verdict" : state}</span></div>${expected !== undefined || actual !== undefined ? `<dl class="scenario-actions">${expected !== undefined ? `<div><dt>Expected</dt><dd>${escape(expected)}</dd></div>` : ""}${actual !== undefined ? `<div><dt>Actual</dt><dd>${escape(actual)}</dd></div>` : ""}</dl>` : ""}${reason ? `<p class="scenario-reason">${escape(reason)}</p>` : ""}</li>`;
        })
        .join("");
      return `<section class="benchmark-results" aria-labelledby="benchmark-heading"><header class="result-header"><div><p class="eyebrow">Evaluation</p><h4 id="benchmark-heading">Benchmark result</h4></div><span class="result-summary">${summary}</span></header>${scenarios.length ? `<ul class="scenario-list">${rows}</ul>` : '<p class="muted">No scenario results are available.</p>'}</section>`;
    }
    const entries = Object.entries(result);
    const facts = entries.filter(
      ([, value]) =>
        value === null ||
        ["string", "number", "boolean"].includes(typeof value),
    );
    const rows = facts
      .map(
        ([key, value]) =>
          `<div class="result-fact"><dt>${escape(key.replaceAll("_", " "))}</dt><dd>${escape(value)}</dd></div>`,
      )
      .join("");
    const lists = entries
      .filter(([, value]) => Array.isArray(value))
      .map(
        ([key, values]) =>
          `<section class="result-list"><h5>${escape(key.replaceAll("_", " "))}</h5><ul>${values
            .map(
              (value) =>
                `<li>${escape(value && typeof value === "object" ? (value.name ?? value.reason ?? JSON.stringify(value)) : value)}</li>`,
            )
            .join("")}</ul></section>`,
      )
      .join("");
    return `<section class="benchmark-results" aria-labelledby="benchmark-heading"><header class="result-header"><div><p class="eyebrow">Evaluation</p><h4 id="benchmark-heading">Benchmark result</h4></div></header>${rows ? `<dl class="result-facts">${rows}</dl>` : ""}${lists}${rows || lists ? "" : '<p class="muted">Result details are unavailable.</p>'}</section>`;
  }

  function nodePanel(node) {
    if (!node) return '<p class="muted">This tree has no nodes yet.</p>';
    const harness = harnessText(node.harness);
    const hasResult =
      node.benchmark_result !== null && node.benchmark_result !== undefined;
    return `<div class="node-panel-head"><div><p class="eyebrow">Selected node</p><h3 id="live-node-heading" tabindex="-1">${escape(labelOf(node))}</h3></div><span class="tag status-${node.status}">${escape(node.status)}</span></div><dl class="node-facts"><div><dt>Node ID</dt><dd><code>${escape(node.id)}</code></dd></div><div><dt>Score</dt><dd>${score(node.score)}</dd></div><div><dt>Parent</dt><dd><code>${escape(node.parent_id || "Root")}</code></dd></div></dl>${node.error !== null && node.error !== undefined ? `<p class="error-copy">${escape(typeof node.error === "string" ? node.error : (node.error.message ?? "Evaluation failed"))}</p>` : ""}${harnessDiff(node)}<details class="config-details"><summary>Harness configuration</summary><div class="copyable-panel"><pre><code>${escape(harness)}</code></pre>${copyControl(node.id, "harness configuration")}</div></details>${hasResult ? benchmarkResult(node) : ""}`;
  }
  function selectNode(node) {
    const panel = detail.querySelector(".node-panel");
    panel.innerHTML = nodePanel(node);
    for (const link of detail.querySelectorAll("[data-node-id]")) {
      if (link.dataset.nodeId === node?.id)
        link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    selectedNodeId = node?.id ?? null;
    ensureVisible();
    schedulePoll();
  }

  // Live eval progress: while the selected node is pending/running, re-fetch
  // the tree every few seconds and re-render only on status/score/result change.
  // Pauses when the tab is hidden (API quota!), never overlaps requests.
  function schedulePoll() {
    window.clearTimeout(pollTimer);
    if (!detail || !selectedTree || !selectedNodeId) return;
    const node = selectedTree.nodeMap.get(selectedNodeId);
    if (!node || (node.status !== "pending" && node.status !== "running"))
      return;
    pollTimer = window.setTimeout(refreshSelected, 3000);
  }

  async function refreshSelected() {
    if (document.hidden || pollInflight || !selectedTree || !selectedNodeId) {
      schedulePoll();
      return;
    }
    pollInflight = true;
    try {
      const response = await fetch(detail.dataset.treeUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Tree API returned ${response.status}`);
      const fresh = prepareTree(await response.json());
      if (fresh.id !== selectedTree.id) return;
      const before = selectedTree.nodeMap.get(selectedNodeId);
      const after = fresh.nodeMap.get(selectedNodeId);
      selectedTree = fresh;
      if (
        after &&
        (!before ||
          before.status !== after.status ||
          before.score !== after.score ||
          JSON.stringify(before.benchmark_result) !==
            JSON.stringify(after.benchmark_result))
      ) {
        renderDetail(fresh);
      } else {
        schedulePoll();
      }
    } catch {
      schedulePoll(); // transient blip; the normal error path owns real failures
    } finally {
      pollInflight = false;
    }
  }

  // Keep the selected node inside the scrollable plate (vertical + horizontal).
  // Only scrolls when out of view; never moves the page itself.
  function ensureVisible() {
    const plate = detail.querySelector(".tree-plate");
    const current = detail.querySelector('.live-node[aria-current="true"]');
    if (!plate || !current) return;
    const plateRect = plate.getBoundingClientRect();
    const nodeRect = current.getBoundingClientRect();
    if (nodeRect.top < plateRect.top || nodeRect.bottom > plateRect.bottom)
      plate.scrollTop += nodeRect.top - plateRect.top - plate.clientHeight / 2;
    if (nodeRect.left < plateRect.left || nodeRect.right > plateRect.right)
      plate.scrollLeft +=
        nodeRect.left - plateRect.left - plate.clientWidth / 3;
  }

  function renderDetail(tree) {
    selectedTree = tree;
    document.getElementById("detail-heading").textContent = tree.name;
    document.title = `${tree.name} · Harness trees`;
    detail.hidden = false;
    detail.innerHTML = `<p class="muted">${escape(tree.description || "No description provided.")}</p><div class="stage plate"><section class="tree-plate" tabindex="0" aria-label="Scrollable harness tree">${nodeTree(tree)}</section><div class="legend" role="group" aria-label="Node status"><span><i class="legend-dot pass" aria-hidden="true"></i>Complete</span><span><i class="legend-dot wait" aria-hidden="true"></i>Pending / running</span><span><i class="legend-dot fail" aria-hidden="true"></i>Failed</span></div></div><article id="live-node" class="node-panel" aria-live="polite"></article>`;
    selectNode(
      (selectedNodeId && tree.nodeMap.get(selectedNodeId)) ??
        tree.nodeMap.get(tree.root_node_id) ??
        tree.nodes[0],
    );
  }

  /** Clipboard write with legacy fallback: navigator.clipboard is absent or
		denied in insecure contexts, execCommand may still work. */
  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Permission denial is expected; the legacy copy path may still work.
      }
    }
    const focused = document.activeElement;
    const selection = window.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.readOnly = true;
    scratch.tabIndex = -1;
    scratch.style.cssText = "position:fixed;top:0;left:-9999px";
    try {
      document.body.append(scratch);
      scratch.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      scratch.remove();
      focused?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }

  /** Below-fold gallery cards fade/slide in on scroll. Runs after each render
		(cards inject post-fetch), honours reduced-motion, no-ops without IO. */
  function revealCards(scope) {
    if (
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting) continue;
          target.classList.add("is-revealed");
          observer.unobserve(target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const card of scope.querySelectorAll(".card")) {
      if (card.getBoundingClientRect().top >= window.innerHeight) {
        card.classList.add("will-reveal");
        observer.observe(card);
      }
    }
  }

  detail?.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("button[data-copy-node]");
    if (copyButton) {
      const node = selectedTree?.nodeMap.get(copyButton.dataset.copyNode);
      const harness = node?.harness;
      // Harness is TEXT (yml): copy raw. Objects (legacy) stay pretty JSON.
      const value =
        typeof harness === "string"
          ? harness
          : JSON.stringify(harness, null, 2);
      const status = copyButton.nextElementSibling;
      if (!node || value === null || value === undefined || value === "") {
        status.textContent = "Copy failed. Content is unavailable.";
        return;
      }
      copyButton.disabled = true;
      let copied = false;
      try {
        copied = await writeClipboard(value);
      } finally {
        copyButton.disabled = false;
      }
      status.textContent = copied
        ? "Copied to clipboard"
        : "Copy failed. Allow clipboard access and try again.";
      return;
    }
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
    // First paint and empty gallery: render placeholders so the layout
    // does not jump when the fetch resolves.
    showGallerySkeletons();
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
          response.status === 404
            ? "Tree not found."
            : `Tree API returned ${response.status}`,
        );
      const payload = await response.json();
      if (cards) {
        if (!Array.isArray(payload?.data))
          throw new Error("Tree API returned an invalid list.");
        const prepared = payload.data.map(prepareTree);
        trees = new Map(prepared.map((tree) => [tree.id, tree]));
        if (trees.size !== prepared.length)
          throw new Error("Tree API returned duplicate trees.");
        count.textContent = `${trees.size} tree${trees.size === 1 ? "" : "s"}`;
        cards.innerHTML = prepared.length
          ? prepared.map(card).join("")
          : '<li class="empty-state"><h2>No trees yet</h2><p>Create a session and evaluate its root node to see it here.</p></li>';
        revealCards(cards);
      } else {
        const tree = prepareTree(payload);
        if (tree.id !== detail.dataset.treeId)
          throw new Error("Tree API returned a different tree.");
        renderDetail(tree);
      }
      status.hidden = true;
    } catch (error) {
      // Drop placeholders on failure so a ghost card never outlives the error.
      if (cards) clearCreatingSkeletons();
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
