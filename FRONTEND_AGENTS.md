# Frontend guidance — live backend viewer and standalone Petri showcase

## Production integration (takes precedence over the showcase notes below)

- The live gallery is `/`, rendered from `app/templates/index.html`. Native cards
  navigate to `/tree/{tree_id}`, rendered from `app/templates/tree.html`. The
  detail page fetches only `/api/v1/trees/{tree_id}` and has a native Back to trees
  link. FastAPI serves frontend assets under `/trees`; REST contracts are unchanged.
- Keep loading, failure and retry handling on both live pages. Node selection
  retains keyboard focus on the selected link; the live region announces changes.
- `frontend/trees-section/production.js` restores the integration from commit
  `54019be`; `production.css` scopes the live viewer's styles to `.live-trees`.
  Keep both assets linked from the production template. No Node build is required
  to serve the live page in the existing Python container.
- Live nodes use `pending`, `running`, `complete`, and `failed`, with nullable
  raw scores, harness JSON, rationale, benchmark results and errors. Harness and
  result payloads have copy controls. Scenario-array benchmark results render as
  passed/failed/unscored cards; summary-only results render as labeled facts.
  Do not show raw result JSON in the normal detail UI. Keep copy payload verbatim.
  The wide lineage SVG is centered in a bounded scroll stage. Do not apply the
  static showcase's acceptance thresholds, basis points, verification keys, or
  Petri CLI instructions to backend data.
- The static showcase remains `/trees/index.html` or a local `file://` page.
  `main.js` only enhances it; `build.mjs` composes the static `templates/` modules.
  Never overwrite production integration with standalone showcase code.
- Run `node checks/integration.mjs` from `frontend/trees-section` for read-only
  same-origin API-contract/browser tests using local fixtures, without database
  access. It covers clipboard payloads, scenario result rendering, sparse-tree
  centering and dropdown pointer behavior. Also run the static build, unit/render
  tests and static checks.
- Frontend `lib/` modules must be tracked in Git. The root `.gitignore` explicitly
  exempts them from the generic Python `lib/` ignore rule.
- Production's live data requires JavaScript, as in the recovered commit. The
  no-JavaScript production shell links to the JSON API/docs instead of showing
  fictional showcase data. The strict no-JavaScript requirements below apply to
  the standalone showcase only.

---

# Standalone showcase notes

Instructions for any AI agent asked to change this project. Read this file first. The
**Traps** section is the important one: every entry there is a bug that has already
happened once, and each one is easy to reintroduce.

---

## 1. What this is

A **standalone, plain HTML/CSS/JS recreation** of the "Trees" section of an app called
Petri. No framework, no bundler, no runtime dependencies.

This file expects to sit **beside** the `trees-section/`, `ref/` and `shots/` folders. If
you move the deliverable somewhere else, move this file with it and fix the paths in §3 and
§4 — the `checks/` scripts contain absolute paths and will need them updated too.

| | |
|---|---|
| Reference repo (Next.js) | `ref/` — a clone of `https://github.com/Avoisavo/ethonline2026` |
| Live reference | `https://ethonline2026-two.vercel.app/` |
| Deliverable | `trees-section/` |
| Screenshots | `shots/` |
| Work log | `.workbuddy-ai/memory/2026-10-10.md` (read this for the history of *why*) |

`ref/` is a **read-only source of truth for behaviour and geometry**. Never edit it. When
the reference and this recreation disagree, the reference usually wins — but see
§6 for the places where diverging was a deliberate decision.

---

## 2. Non-negotiable constraints

1. **Everything must work with JavaScript disabled.** This is the headline requirement and
   the one most likely to be broken by a careless change. Read §5 before touching anything
   interactive.
2. **No dependencies.** No npm packages, no framework, no bundler, no CDN script. The
   build step is `node build.mjs` using Node's standard library only.
3. **The output opens from `file://`.** No server required. Every page is written into one
   flat folder so the stylesheet, the script and the cross-page links are plain siblings.
4. **Static HTML, generated at build time.** Pages must be complete and readable before any
   script runs.
5. **Visually faithful to the reference**, except for the deliberate divergences in §6.

---

## 3. Layout

```
trees-section/
  build.mjs                 THE GENERATOR. Emits every page and every per-tree stylesheet.
  data.mjs                  Tree registry: TREES[] + loadTree(). Showcase or real snapshot.
  main.js                   The only browser script. Strictly additive (see §5.4).
  styles.css                Shared theme. M3 dark, blue seed. @layer tokens…motion.
  lib/
    layout.mjs              buildForest / tidySlots — port of ref/lib/layout.ts
    glyph.mjs               The per-node status glyph (port of ref/components/Glyph.tsx)
    metrics.mjs             changesOf / fmtPct
    format.mjs              Status words, basis points, node numbers, claim/sign helpers
    objectives.mjs          OBJECTIVES — the fork "direction" options
  data/
    showcase.mjs            5 hand-authored trees (port of ref/lib/showcase.ts)
    petri-export.json       Real `petri export` snapshot (1 tree)
    petri-digest.json       Its digest panel
  checks/                   The verification suite. See §4.2.
  index.html                GENERATED — the gallery
  <slug>.html   × 6         GENERATED — one detail page per tree
  <slug>.css    × 6         GENERATED — that page's selection rules
```

The six slugs: `research--hermes-agent--claude-sonnet-5`,
`coding--claude-code--claude-opus-5`, `coding--petri-harness-v1--claude-sonnet-5`,
`finance--pi--claude-haiku-4-5`, `security--codex-cli--gpt-5`,
`data-analysis--openhands--gemini-2-5-pro`.

**Never hand-edit a generated file.** `index.html`, `<slug>.html` and `<slug>.css` are
overwritten on every build. The `<slug>.css` files say so in a header comment. Edit
`build.mjs`, `styles.css`, `main.js` or `data/`, then rebuild.

---

## 4. Commands

### 4.1 Build

```bash
cd trees-section
node build.mjs
```

Expected: `Wrote index.html, 6 tree pages (…) and 6 tree stylesheets (…).` The byte counts
move as content changes — only the shape of the message matters.

Plain `node` is fine if it is on PATH. Otherwise use the managed runtime:
`C:/Users/liewjayyong/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`

### 4.2 Checks

Playwright is **not** a dependency of the deliverable — it is a dev tool, already installed
at `C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core`.
The scripts resolve it via `createRequire` against that path.

```bash
cd trees-section/checks
node verify.mjs        # contrast, font sizes, tap targets; then the JS-on interaction path
node nojs.mjs          # THE HEADLINE CHECK — the same interactions with JavaScript disabled
node sweep.mjs         # 7 pages × 9 widths (360…1920): overflow, escaped elements, sticky overlap
node palette.mjs       # resolved colour of every semantic element; flags any non-blue hue
node clipboard.mjs     # the clipboard really receives the command; the icon swaps
node copy-fallback.mjs # the no-navigator.clipboard path, and that the glyph actually draws
node cmd-box.mjs       # copy control geometry inside the command box; no word split
node shots.mjs         # regenerates ../shots/
```

**Caveat — read the output, not just the exit code.** Only `cmd-box.mjs` calls
`process.exit(1)` on failure. The others print failures and still exit `0`. Do not treat a
zero exit as a pass.

### 4.3 Definition of done

Any change to layout, CSS or markup must end with all of these green:

| Check | Expected |
|---|---|
| `verify.mjs` | `contrast 0`, `<12px 0`, `tap<24 0` on all three pages; selection/chips/switch correct |
| `nojs.mjs` | node click, narrow list-row click and "Full record" all swap strip **and** panel; 6 gallery links |
| `sweep.mjs` | `0 failing viewport/page combinations out of 63` |
| `palette.mjs` | `All non-failure chrome sits in the blue family.` |
| `clipboard.mjs` | clipboard matches `data-copy`; `0 copy buttons rendered with no script` |
| `copy-fallback.mjs` | tick shown via fallback; glyph drawn 16×16 |
| `cmd-box.mjs` | `0 failure(s)` |

---

## 5. The four mechanisms

Understand these before changing anything interactive. They are what make the JS-off
requirement work.

### 5.1 Layout is solved at build time

A tidy tree's row layout depends on how many leaves sit above each node. `lib/layout.mjs`
computes that in Node, so each page ships complete static SVG. The browser never computes
geometry. **If you add a node or change the tree shape, rebuild — do not try to fix layout
in CSS or JS.**

### 5.2 State lives in CSS

The Tree|Stats switch and the four info chips are **native radio groups**
(`<input>` + `<label>`), shown and hidden with `body:has(#id:checked)`. No JS, and the
arrow keys work natively. Do not convert these to buttons or add JS to them.

### 5.3 Selection has two paths and one outcome

Which version is on show can be decided two ways, and they must never fight:

- **No script** — the figure links to `#s-<short>`, and the generated `<slug>.css` uses
  `:target`.
- **With script** — `main.js` adds `is-open` to a `.selected-strip`, because `:target` is
  **not** re-evaluated when the fragment is rewritten in place (see Trap 1).

The generated rules cover both, and the `:target` half disables itself the moment a strip is
marked:

```css
:is(body:not(:has(.selected-strip.is-open)):has(#s-he-07:target),
    body:has(.selected-strip.is-open):has(.selected-strip[data-for="he-07"].is-open))
```

The mechanism is **custom properties**, not declarations — one rule covers the wide figure
and the narrow list, another covers the strip and its record. `styles.css` supplies the
defaults (`--sel-ring` falls back to `none`), so an unchosen version costs nothing.

### 5.4 The progressive-enhancement gate

Controls that genuinely need a script carry `.needs-js` and are **hidden until the script
runs**:

```css
.needs-js { display: none; }                    /* not display:none in the markup */
html.has-js .icon-btn.needs-js { display: inline-flex; }
```

`main.js` adds `html.has-js` before it does anything else. So if the script never loads, the copy
buttons and the direction picker are simply absent — never shown-but-inert. The commands
themselves stay readable as plain text. **Never add a control that looks interactive but
needs JS without this gate.**

---

## 6. Deliberate divergences from the reference

These are **intentional**. Do not "fix" them back to the reference without being asked.

| Area | Ours | Reference |
|---|---|---|
| Colour | M3 dark seeded from **blue** | M3 baseline purple (`#6750A4`) |
| `tertiary` | cyan (`#a2d2df`) | M3 pink |
| `.record-info` | `position: sticky` | static (leaves a tall void) |
| `.chips` | bare M3 filter-chip group, 32px, gap 8 | nested in a sunk panel, 34px, gap 4 |
| Radii | 8px / 12px (`--shape-sm` etc.) | fixed 10px |
| Copy control | 32px **icon button** with a clipboard glyph, **inside** the command box in both blocks | text button reading "Copy"; inside in `.checkit-cmd`, but **below** the command in `.np-block.fork` |
| `build.mjs` output | flat folder (`index.html`, `<slug>.html`) | Next.js routes |

The **copy control placement** is worth calling out because the reference is itself
inconsistent — see the table above. We put it inside in both places. The one consequence:
the button takes ~34px of the command's width (300 → 266px), which is what pushes the fork
command into wrapping at sidebar widths.

---

## 7. Traps

Each entry: symptom → cause → the fix that works.

### 7.1 `:target` is not re-evaluated by `history.replaceState()`

**Symptom.** Clicking a tree node changes the URL but nothing on screen moves.
**Cause.** The code drove selection off `:target` and only called `replaceState`.
Rewriting the fragment in place does not re-resolve `:target`.
**Fix.** `main.js` drives selection with the `is-open` class; the fragment is kept only so
the URL stays shareable. This is what §5.3 exists for.
**Trap.** A one-off test *appears* to prove `replaceState` works if it sets the fragment
during initial script execution — before the first style resolution, the target is simply
computed for the first time. Test the click, not the load.

### 7.2 One fragment cannot mean two things

**Symptom (JS off).** Clicking "Full record ↓" silently resets the page to its default
version.
**Cause.** The strip carried `id="s-<short>"` and the figure linked to it, but "Full record"
pointed at `#record`, which matches none of the generated `#s-*:target` rules — so every
strip collapsed.
**Fix.** The `s-<short>` id lives on the **record `<article class="rec">`**, so one fragment
both selects the version and scrolls to it. `main.js` keys selection off
`strip.dataset.for`, not `strip.id`, and the "Full record" link is a plain anchor with no
`preventDefault`. `.rec` carries `scroll-margin-block-start: 64px` to clear the top bar.
The "nothing chosen yet" test is therefore `body:not(:has(.rec:target))` — **not**
`.selected-strip:target`.

### 7.3 `data-fork-out` must stay on the `<pre>`

**Symptom.** The fork block's copy button disappears the first time the direction picker
changes.
**Cause.** `main.js` does `out.textContent = …`, which **replaces every child**. If the
attribute sits on the wrapper, the button is a child and gets deleted.
**Fix.** Keep `data-fork-out` on the `<pre>` and the button a *sibling* of it.
`checks/cmd-box.mjs` asserts both.

### 7.4 The copy button is a sibling, not a child

Same root cause as 7.3, generalised: **never nest a copy button inside the element whose
text is copied.** `data-copy` (literal string) and `data-copy-out` (read from a
`[data-fork-out]` element) are the two hooks.

### 7.5 Chromium reports `fill` as `rgb(0, 0, 0)` for HTML elements

**Symptom.** A colour probe reports black for every link.
**Cause.** For an **HTML** element, `fill` is a meaningless `rgb(0, 0, 0)` — it is *not*
`none`. A probe that "falls back to `color` when `fill` is none" silently reports black.
**Fix.** Name the CSS channel to read per element in `checks/palette.mjs` (`PROBES`).

### 7.6 Playwright forces light mode

Every page here is dark-only. Pass `colorScheme: "dark"` to the context, or screenshots and
measurements will not match.

### 7.7 `waitUntil: "load"` never settles on `file://` with scripting off

Use `{ waitUntil: "domcontentloaded" }` in a `javaScriptEnabled: false` context.

### 7.8 Chromium normalises clipboard newlines to CRLF

Comparing clipboard content against a `<pre>`'s text fails on `\n` vs `\r\n`. Normalise
before comparing.

### 7.9 Unscoped selectors match hidden records

**Symptom.** A geometry assertion passes when it should fail, or a readability check
reports `false`.
**Cause.** Every record ships its own fork block, check-it list and panels, but only one is
displayed. `document.querySelector(".fork .cmd")` returns the **first**, which belongs to a
hidden record and measures **0×0** — and a 0×0 box satisfies every containment test for
free.
**Fix.** Scope to the visible record: `.rec[data-for="he-08"]`. `checks/cmd-box.mjs`
additionally asserts the box has non-zero size, so a vacuous pass is impossible.

### 7.10 Edge reports `file://` as a secure context

**Symptom.** The `execCommand` fallback path is never exercised locally.
**Cause.** `navigator.clipboard` is present even on `file://` in Edge, so the fallback never
runs.
**Fix.** `checks/copy-fallback.mjs` deletes `navigator.clipboard` before load to force the
fallback. The fallback is not dead code — it is the only route in a genuinely insecure
context.

### 7.11 The figure's SVG text is in user units

`.h-word`, `.h-num` and the objective labels are inside the SVG viewBox, and the build
computes label boxes from character counts. **Resizing them desyncs the geometry.** The
"no text below 12px" rule applies to HTML labels only.

### 7.12 A `--flag` can break after its hyphen

**Symptom.** A command renders as `--` at the end of one line and `area` at the start of the
next.
**Cause.** A hyphen is a legitimate CSS break opportunity.
**Fix.** There isn't one in CSS. `word-break: keep-all`, `line-break: strict`,
`break-spaces` and `overflow-wrap: anywhere` were all measured and break in the same place.
Only markup around each token would stop it. `checks/cmd-box.mjs` reports it as a `note`,
not a failure. A soft wrap inserts **no characters**, so the clipboard payload is unaffected.

### 7.13 `overflow-wrap: break-word` splits words mid-token

It breaks a token at the overflow point — `improves` becomes `improv` / `es`. Use
`overflow-wrap: normal`, which only breaks at real opportunities.

**Trap within the trap:** at the real content widths, `break-word` and `normal` render
*identically*, so a test asserting "no mid-word break" passes under both and proves nothing.
The assertion only becomes meaningful with a synthetic over-long token. If a test can never
go red, it is not evidence.

### 7.14 `@layer` order is load-bearing

`@layer tokens, base, layout, card, glyph, page, motion;` — this is why the stylesheet needs
no `!important`. Put new rules in the correct layer. `.checkit-cmd` sits in `page`, after
`.cmd`, and relies on source order for its one extra declaration.

### 7.15 Tap targets need real padding

A `::after` pseudo-element "hit area" was tried and **reverted**: `elementsFromPoint` showed
it does not extend the hit area, and tooling cannot measure it. Use real `padding-block`.

### 7.16 Do not hand-edit generated CSS or HTML

`<slug>.css` carries a GENERATED header. Edit `selectionCss()` in `build.mjs` and rebuild.

---

## 8. Conventions

- **Comments explain *why*, not what.** A rule that looks odd usually has a reason recorded
  next to it — read it before changing the rule. Several comments name the alternative that
  was measured and rejected.
- **Escape every interpolation** in `build.mjs` with `esc()`.
- **No raw colour outside `@layer tokens`.** Use M3 role names (`--md-sys-color-*`),
  `--md-state-*` for state layers, `--shape-*` for radii, `--type-*` for type. If a value is
  not an M3 role, say so in a comment.
- **Additive JS only.** If `main.js` never loads, the pages still work. Anything that cannot
  meet that bar goes behind the `.needs-js` gate.
- **Prefer one shared rule over two near-identical ones.** The two command blocks share
  `.cmd`; the two strip/record reveals share the generated `--sel-*` properties.
- **Delete dead CSS.** There is no unused-class linter in `checks/`, so grep the stylesheet
  against the generated markup before assuming a class is still needed. (An earlier
  `check.mjs` did this and is no longer present — worth reinstating if dead CSS becomes a
  recurring problem.)

---

## 9. Do not

- Add a dependency, framework, bundler or CDN script.
- Add a build step other than `node build.mjs`.
- Move a page into a subdirectory. The preview harness maps each directory to its own base
  path, so `index.html` and `tree/*.html` would get different bases and every card link
  would 404. Everything lives in one flat folder for this reason.
- Hand-edit `index.html`, `<slug>.html` or `<slug>.css`.
- Edit anything in `ref/`.
- Convert the radio-group switch or chips to JS.
- Put an interactive-looking control in the markup without the `.needs-js` gate.
- Trust a green test without checking it can go red (see 7.13).
- Claim a layout change is done without running `sweep.mjs` — 63 viewport/page
  combinations is the only thing that catches a narrow-width regression.

---

## 10. If you are asked to match the reference more closely

1. Measure, do not eyeball. Render the live site with Playwright at the same viewport
   (`colorScheme: "dark"`) and compare **computed box models**.
2. Compare the DOM, not just the pixels. A previous "the switch must be fragment-driven"
   assumption was wrong — reading `ref/components/Panels.tsx` showed React buttons with
   `aria-pressed` and no anchors at all, and the change was reverted.
3. Check §6 first — the difference may be deliberate.
4. After any change, run the full suite in §4.3.
