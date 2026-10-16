import { store } from "./storage.js";

const closedKey = "kiln:closed-sections";
const scrollKey = "kiln:sidebar-scroll";

/**
 * Remembers which sidebar sections the reader closed, and where the sidebar was scrolled to,
 * so both carry over to the next page. The inline scripts in `sidebar.kiln` and `docs.kiln` restore them.
 */
export const initNav = () => {
	document.addEventListener(
		"toggle",
		(event) => {
			const section = event.target;
			if (!(section instanceof HTMLDetailsElement) || !section.dataset.section)
				return;
			let closed: string[] = [];
			try {
				closed = JSON.parse(store.get("local", closedKey) ?? "[]");
			} catch {}
			const others = closed.filter(
				(title) => title !== section.dataset.section,
			);
			store.set(
				"local",
				closedKey,
				JSON.stringify(
					section.open ? others : [...others, section.dataset.section],
				),
			);
		},
		// `toggle` doesn't bubble.
		true,
	);

	const scroller = document.querySelector("[data-sidebar-scroll]");
	if (!scroller) return;
	const save = () =>
		store.set("session", scrollKey, String(scroller.scrollTop));
	// `pageswap` runs before the next page loads, where browsers support it. `pagehide` covers the rest.
	addEventListener("pageswap", save);
	addEventListener("pagehide", save);
};
