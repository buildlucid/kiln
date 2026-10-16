/**
 * Turns `[data-tabs]` into tabs. The markup has `role="tab"` buttons that control `role="tabpanel"`s,
 * with the first panel showing, so the content works without this script.
 *
 * Adds `in-view` to the tabs the first time they scroll into view, which starts the bar animations.
 */
export const initTabs = () => {
	for (const root of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
		const tabs = Array.from(
			root.querySelectorAll<HTMLButtonElement>("[role=tab]"),
		);

		const select = (tab: HTMLButtonElement, focus = false) => {
			for (const other of tabs) {
				const selected = other === tab;
				other.setAttribute("aria-selected", String(selected));
				other.tabIndex = selected ? 0 : -1;
				const panel = document.getElementById(
					other.getAttribute("aria-controls") ?? "",
				);
				if (panel) panel.hidden = !selected;
			}
			if (focus) tab.focus();
			// Bring a tab that was partly hidden by the scrolling row fully into view.
			tab.scrollIntoView({
				block: "nearest",
				inline: "nearest",
				behavior: "smooth",
			});
		};

		root.addEventListener("click", (event) => {
			const tab =
				event.target instanceof Element &&
				event.target.closest<HTMLButtonElement>("[role=tab]");
			if (tab) select(tab);
		});

		root.addEventListener("keydown", (event) => {
			const index = tabs.findIndex((tab) => tab === document.activeElement);
			if (index < 0) return;
			const step = {
				ArrowRight: 1,
				ArrowLeft: -1,
				Home: -index,
				End: tabs.length - 1 - index,
			}[event.key];
			if (step === undefined) return;
			event.preventDefault();
			const tab = tabs[(index + step + tabs.length) % tabs.length];
			if (tab) select(tab, true);
		});

		new IntersectionObserver(
			([entry], observer) => {
				if (!entry?.isIntersecting) return;
				root.classList.add("in-view");
				observer.disconnect();
			},
			{ threshold: 0.3 },
		).observe(root);
	}
};
