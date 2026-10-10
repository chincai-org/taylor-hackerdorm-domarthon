/** Optional polish only: navigation, CSS radios, and records work without this file. */

const isPlainClick = (event) =>
	event.button === 0 &&
	!event.metaKey &&
	!event.ctrlKey &&
	!event.shiftKey &&
	!event.altKey;

function enhanceGallery() {
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

	for (const card of document.querySelectorAll(".card")) {
		if (card.getBoundingClientRect().top >= window.innerHeight) {
			card.classList.add("will-reveal");
			observer.observe(card);
		}
	}
}

function enhanceSelection() {
	const strips = [...document.querySelectorAll(".selected-strip")];
	const ids = new Set(strips.map((strip) => strip.dataset.for));
	if (!ids.size) return;

	const select = (short) => {
		for (const strip of strips) {
			strip.classList.toggle("is-open", strip.dataset.for === short);
		}
	};
	const syncHash = () =>
		select(location.hash.startsWith("#s-") ? location.hash.slice(3) : null);

	// replaceState does not update :target. Classes enhance figure/list selection;
	// record and parent links keep their native scrolling and history behavior.
	document.addEventListener("click", (event) => {
		if (!isPlainClick(event)) return;
		const link = event.target.closest('a[href^="#s-"]');
		const fragment = link?.getAttribute("href");
		if (!fragment || !ids.has(fragment.slice(3))) return;

		// Reveal a parent record before native anchor scrolling measures its position.
		select(fragment.slice(3));
		if (link.matches(".h-node, .t-row")) {
			event.preventDefault();
			history.replaceState(null, "", fragment);
		}
	});
	window.addEventListener("hashchange", syncHash);
	window.addEventListener("popstate", syncHash);
	syncHash();
}

// Index data attributes directly: no dynamic selector escaping or repeated DOM scans.
const forkOutputs = new Map(
	[...document.querySelectorAll("[data-fork-out]")].map((output) => [
		output.dataset.forkOut,
		output,
	]),
);

function enhanceForks() {
	for (const picker of document.querySelectorAll("select[data-fork]")) {
		const output = forkOutputs.get(picker.dataset.fork);
		if (!output || !picker.dataset.template) continue;
		const render = () => {
			output.textContent = picker.dataset.template
				.replaceAll("{{motif}}", picker.value.replace(/\s+/g, "-"))
				.replaceAll("{{direction}}", picker.value);
		};
		picker.addEventListener("change", render);
		render();
	}
}

/** Falls back when clipboard permissions or the secure-context requirement deny access. */
async function writeClipboard(text) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denial is expected; the legacy copy path may still be available.
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
		// Always remove the temporary node, even when execCommand throws.
		scratch.remove();
		focused?.focus({ preventScroll: true });
		if (selection) {
			selection.removeAllRanges();
			for (const range of ranges) selection.addRange(range);
		}
	}
}

function enhanceCopyButtons() {
	for (const button of document.querySelectorAll("button.copy")) {
		const label = button.getAttribute("aria-label") ?? "Copy";
		const status = document.createElement("span");
		status.className = "sr-only";
		status.setAttribute("role", "status");
		button.after(status);
		let resetTimer;

		const reset = () => {
			button.classList.remove("is-copied");
			button.setAttribute("aria-label", label);
		};

		button.addEventListener("click", async () => {
			window.clearTimeout(resetTimer);
			reset();
			status.textContent = "";
			const output = forkOutputs.get(button.dataset.copyOut);
			const text =
				button.dataset.copy ??
				(output?.isConnected ? output.textContent : null);
			if (!text) {
				status.textContent = "Copy failed. The command is unavailable.";
				return;
			}

			// One outstanding copy per button; an older response cannot overwrite a newer one.
			const focused = document.activeElement;
			button.disabled = true;
			let copied;
			try {
				copied = await writeClipboard(text);
			} finally {
				button.disabled = false;
				if (document.activeElement === document.body)
					focused?.focus({ preventScroll: true });
			}
			status.textContent = copied
				? "Copied to clipboard"
				: "Copy failed. Select the command and copy it by hand.";
			if (!copied) return;

			button.classList.add("is-copied");
			button.setAttribute("aria-label", "Copied");
			resetTimer = window.setTimeout(reset, 1600);
		});
	}
}

enhanceGallery();
enhanceSelection();
enhanceForks();
enhanceCopyButtons();
// Reveal script-only controls only after their event handlers are ready.
document.documentElement.classList.add("has-js");
