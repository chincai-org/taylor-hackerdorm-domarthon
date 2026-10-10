/**
 * Progressive enhancement for the whole site.
 *
 * Nothing here is needed to read a page. The gallery and every tree page are
 * complete static HTML, and the CSS on its own already handles the Tree/Stats
 * switch, the info chips, and which version's record is on show. This file only
 * smooths the edges:
 *
 *   - it fades a gallery card's tree in as the card scrolls into view;
 *   - it picks a version without the page jumping to the anchor;
 *   - it reveals the two controls that genuinely need a script (copy buttons,
 *     the fork direction picker) — those are hidden until `has-js` is set, so
 *     nothing inert is ever shown.
 *
 * Everything it does is additive: if this file never loads, the pages still work.
 */

document.documentElement.classList.add("has-js");

/** `CSS.escape` is not in every engine; the ids here are plain slugs anyway. */
const escapeId = (value) => (window.CSS?.escape ? CSS.escape(value) : value);

/** A plain left click. Modified clicks mean "open in a new tab", so leave them. */
const isPlainClick = (event) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/* ------------------------------------------------------------------ *
 * Gallery — reveal each card's tree as it scrolls in
 * ------------------------------------------------------------------ */

(() => {
  if (!("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        target.classList.add("is-revealed");
        observer.unobserve(target); // one-shot: reveal once, then stop watching
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );

  for (const card of document.querySelectorAll(".card")) {
    // Leave anything already on screen alone: animating content the visitor can
    // see reads as a flicker, not as a reveal.
    if (card.getBoundingClientRect().top >= window.innerHeight) {
      card.classList.add("will-reveal");
      observer.observe(card);
    }
  }
})();

/* ------------------------------------------------------------------ *
 * Tree page — choose a version
 * ------------------------------------------------------------------ */

/**
 * The figure links straight to a version's record id (`#s-<short>`), so with no
 * script the record swap is pure CSS and the browser also scrolls to it — one
 * fragment does both jobs.
 *
 * With a script we take over the choosing, because `:target` is NOT re-evaluated
 * when the fragment is rewritten in place — so driving selection off the fragment
 * alone would leave a click doing nothing. Selection is therefore an `is-open`
 * class on the strip, and the fragment is kept only so the URL stays shareable.
 * The generated rules in the page head switch the `:target` path off as soon as a
 * strip is marked, so the two can never show two records at once.
 */
(() => {
  const strips = [...document.querySelectorAll(".selected-strip")];
  const ids = new Set(strips.map((strip) => strip.dataset.for));
  if (ids.size === 0) return;

  // Selection is keyed by the version's short name; the record article carries
  // the `s-<short>` id that the fragment matches.
  const select = (short) => {
    for (const strip of strips) strip.classList.toggle("is-open", strip.dataset.for === short);
  };

  for (const link of document.querySelectorAll('a[href^="#s-"]')) {
    link.addEventListener("click", (event) => {
      if (!isPlainClick(event)) return;

      const short = link.getAttribute("href").slice(3);
      if (!ids.has(short)) return;

      event.preventDefault();
      select(short);
      history.replaceState(null, "", `#s-${short}`);
    });
  }

  // A fragment present on load was already honoured by the CSS; mirror it into
  // the class so both mechanisms agree from here on.
  const initial = location.hash.replace(/^#s-/, "");
  if (ids.has(initial)) select(initial);
})();

/* ------------------------------------------------------------------ *
 * Tree page — the fork command follows the direction picker
 * ------------------------------------------------------------------ */

(() => {
  for (const picker of document.querySelectorAll("select[data-fork]")) {
    const out = document.querySelector(`[data-fork-out="${escapeId(picker.dataset.fork)}"]`);
    if (!out) continue;

    // The command text ships in the markup (see `forkTemplate` in build.mjs), so
    // there is only ever one copy of it to keep right.
    const render = () => {
      const direction = picker.value;
      out.textContent = picker.dataset.template
        .replaceAll("{{motif}}", direction.replace(/\s+/g, "-"))
        .replaceAll("{{direction}}", direction);
    };
    picker.addEventListener("change", render);
    render();
  }
})();

/* ------------------------------------------------------------------ *
 * Copy buttons — a literal command, or whatever the fork picker shows
 * ------------------------------------------------------------------ */

/**
 * Put `text` on the clipboard.
 *
 * `navigator.clipboard` needs a secure context, so it is absent when a page is
 * opened straight from disk over `file://` — which is exactly how this is meant
 * to be used. The `execCommand` path covers that: `document.execCommand` is
 * deprecated but it is still the only route in a non-secure context, and a
 * deprecated fallback that works beats a modern API that silently does nothing.
 */
const writeClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission, or a context the API will not serve. Try the fallback.
    }
  }

  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    // Off-screen but still focusable: `select()` does nothing on a detached node.
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.top = "0";
    scratch.style.left = "-9999px";
    document.body.append(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
};

(() => {
  /** The text this button is responsible for. */
  const textOf = (button) => {
    if (button.dataset.copy) return button.dataset.copy;
    if (button.dataset.copyOut) {
      return document.querySelector(`[data-fork-out="${escapeId(button.dataset.copyOut)}"]`)?.textContent ?? "";
    }
    return "";
  };

  for (const button of document.querySelectorAll("button.copy")) {
    // The button has no text, so success is shown by swapping an icon and
    // announcing it. Without the announcement an icon-only control gives a
    // screen reader no feedback at all that anything happened.
    const status = document.createElement("span");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    button.after(status);

    let reset = 0;

    button.addEventListener("click", async () => {
      const text = textOf(button);
      if (!text) return;

      const copied = await writeClipboard(text);
      status.textContent = copied ? "Copied to clipboard" : "Copy failed. Select the command and copy it by hand.";

      // No tick on failure: the icon must not claim something that did not happen.
      if (!copied) return;

      button.classList.add("is-copied");
      button.setAttribute("aria-label", "Copied");
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", button.dataset.label ?? "Copy");
      }, 1600);
    });

    // Remember the original label so the reset above can restore it exactly.
    button.dataset.label = button.getAttribute("aria-label") ?? "Copy";
  }
})();
