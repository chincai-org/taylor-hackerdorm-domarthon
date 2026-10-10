# Sharpmon — 3-minute hackathon pitch

## Intent
- **Audience:** Hackathon judges and technical builders.
- **Core goal:** Make the audience remember that agent quality is often determined by the harness around the model, and that Sharpmon turns prompt tweaking into a measurable optimization loop.
- **Length:** 4 pages, approximately 3 minutes total (40–50 seconds per page).
- **Tone:** Dark, technical, high-contrast, demo-ready, confident.
- **Boundary:** Customer-support agents only. Focus on the problem, the loop, and why failures are useful. Do not explain implementation details beyond MCP, FastAPI, and judge scoring.

## Narrative arc
1. **Cover / peak:** Reframe the problem: do not just change the model; optimize its harness.
2. **Supporting / valley:** Show what the harness contains and why quality is otherwise invisible.
3. **Peak:** Walk through the Workbuddy → MCP → evaluator loop.
4. **Ending / peak:** Land the differentiator: every attempt becomes evidence, including failures.

## Page outline

### 01 — Stop guessing. Optimize the harness.
- type: cover
- role: hero
- rhythm: peak
- layout: full-width dark field + asymmetric title + tree motif
- visual: L1 inline SVG tree, anchor
- density: about 35 words / 1 diagram / about 35% whitespace
- anti_pattern: no feature list; no small decorative logo; no dense subtitle block
- description: A customer-support agent is shaped by more than its model. Sharpmon makes that wrapper improvable and measurable.

### 02 — The model is only half the product.
- type: content
- role: supporting
- rhythm: valley
- layout: left title rail + right stacked harness layers
- visual: Diagram of prompt, tools, routing, policy, evidence
- density: about 80 words / 1 diagram / about 25% whitespace
- anti_pattern: no equal-width card grid; no generic AI claims; no unexplained jargon
- description: The harness controls behavior. Without versioning and benchmarks, teams cannot tell which change helped or why an agent regressed.

### 03 — A closed loop for better behavior.
- type: content
- role: hero
- rhythm: peak
- layout: asymmetric process diagram with highlighted judge step
- visual: L1 inline SVG loop, anchor
- density: about 95 words / 1 diagram / about 20% whitespace
- anti_pattern: no linear checklist; no hidden evaluation step; no unbounded rewrite of the harness
- description: Workbuddy checks out context, reads the exact parent, proposes bounded changes, and submits a child. The server rolls out each scenario and scores it with a fixed rubric.

### 04 — Every attempt becomes evidence.
- type: ending
- role: hero
- rhythm: peak
- layout: giant score anchor + branching tree + closing CTA
- visual: L1 inline SVG tree with score markers, anchor
- density: about 55 words / 1 diagram / about 40% whitespace
- anti_pattern: no fake benchmark numbers; no success-only showcase; no unresolved promise of autonomy
- description: Scores are comparable, failures remain visible, and the next optimization starts with what the tree already learned. The demo action is simple: "Improve this node."
