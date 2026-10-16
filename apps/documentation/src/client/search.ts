/** The parts of Pagefind's browser API the dialog uses. See https://pagefind.app/docs/api/. */
type Pagefind = {
	options(options: { excerptLength?: number }): Promise<void>;
	init(): Promise<void>;
	debouncedSearch(
		term: string,
		options?: object,
		debounceMs?: number,
	): Promise<{ results: { data(): Promise<PagefindPage> }[] } | null>;
};

type PagefindPage = {
	url: string;
	excerpt: string;
	meta: { title?: string; section?: string };
	sub_results: { title: string; url: string; excerpt: string }[];
};

/** Pagefind writes its bundle here at build time. In dev, the Vite plugin builds it on request. */
const bundle = "/pagefind/pagefind.js";

let pagefind: Promise<Pagefind> | undefined;
const loadPagefind = () =>
	(pagefind ??= import(/* @vite-ignore */ bundle).then(
		async (module: Pagefind) => {
			await module.options({ excerptLength: 16 });
			await module.init();
			return module;
		},
	));

const maxPages = 8;
const maxSections = 3;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Opens the search dialog from the header button, Cmd/Ctrl+K or `/`, and shows Pagefind's results as you type. */
export const initSearch = () => {
	const dialog = document.querySelector<HTMLDialogElement>("#search");
	const input = dialog?.querySelector<HTMLInputElement>("[data-search-input]");
	const list = dialog?.querySelector<HTMLElement>("[data-search-results]");
	const status = dialog?.querySelector<HTMLElement>("[data-search-status]");
	if (!dialog || !input || !list || !status) return;

	for (const key of document.querySelectorAll("[data-shortcut]"))
		key.textContent = isMac ? "⌘K" : "Ctrl K";

	let options: HTMLAnchorElement[] = [];
	let active = -1;

	const setActive = (index: number, scroll = true) => {
		options[active]?.removeAttribute("aria-selected");
		active = index;
		const option = options[active];
		if (!option) return input.removeAttribute("aria-activedescendant");
		option.setAttribute("aria-selected", "true");
		input.setAttribute("aria-activedescendant", option.id);
		if (scroll) option.scrollIntoView({ block: "nearest" });
	};

	const option = (
		url: string,
		title: string,
		excerpt: string,
		kind: "page" | "section",
	) => {
		const link = document.createElement("a");
		link.href = url;
		link.id = `search-option-${options.length}`;
		link.className = `search-option search-option-${kind}`;
		link.setAttribute("role", "option");
		link.tabIndex = -1;
		const heading = document.createElement("span");
		heading.className = "search-option-title";
		heading.textContent = title;
		const text = document.createElement("span");
		text.className = "search-option-excerpt";
		// Pagefind escapes the page text and wraps matches in <mark>.
		text.innerHTML = excerpt;
		link.append(heading, text);
		options.push(link);
		return link;
	};

	const render = (term: string, pages: PagefindPage[]) => {
		options = [];
		active = -1;
		const groups = pages.map((page) => {
			const group = document.createElement("div");
			group.className = "search-group";
			group.setAttribute("role", "group");
			const title = page.meta.title ?? page.url;
			group.setAttribute("aria-label", title);
			if (page.meta.section) {
				const section = document.createElement("p");
				section.className = "search-group-section";
				section.textContent = page.meta.section;
				section.setAttribute("aria-hidden", "true");
				group.append(section);
			}
			group.append(option(page.url, title, page.excerpt, "page"));
			for (const sub of page.sub_results
				.filter((sub) => sub.url !== page.url)
				.slice(0, maxSections))
				group.append(option(sub.url, sub.title, sub.excerpt, "section"));
			return group;
		});
		list.replaceChildren(...groups);
		input.setAttribute("aria-expanded", String(options.length > 0));
		status.textContent = pages.length ? "" : `No results for “${term}”.`;
		status.hidden = pages.length > 0;
		setActive(options.length ? 0 : -1, false);
		list.scrollTop = 0;
	};

	const search = async () => {
		const term = input.value.trim();
		if (!term) {
			list.replaceChildren();
			input.setAttribute("aria-expanded", "false");
			status.hidden = false;
			status.textContent = "Search tags, filters, functions and guides.";
			return;
		}
		try {
			const response = await (
				await loadPagefind()
			).debouncedSearch(term, {}, 120);
			// A newer search replaced this one.
			if (!response || input.value.trim() !== term) return;
			render(
				term,
				await Promise.all(
					response.results.slice(0, maxPages).map((result) => result.data()),
				),
			);
		} catch (error) {
			console.error(error);
			status.hidden = false;
			status.textContent = "Search isn't available right now.";
		}
	};

	const open = () => {
		if (dialog.open) return;
		dialog.showModal();
		input.select();
		loadPagefind().catch(() => {});
	};

	for (const button of document.querySelectorAll("[data-search-open]")) {
		button.addEventListener("click", open);
		// Start loading the index as soon as the reader shows interest.
		button.addEventListener(
			"pointerenter",
			() => loadPagefind().catch(() => {}),
			{ once: true },
		);
	}
	dialog
		.querySelector("[data-search-close]")
		?.addEventListener("click", () => dialog.close());

	document.addEventListener("keydown", (event) => {
		const typing =
			event.target instanceof HTMLElement &&
			(event.target.isContentEditable ||
				/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
		if (
			(event.key === "k" && (event.metaKey || event.ctrlKey)) ||
			(event.key === "/" && !typing)
		) {
			event.preventDefault();
			if (dialog.open) dialog.close();
			else open();
		}
	});

	input.addEventListener("input", search);
	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!options.length) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((active + step + options.length) % options.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			options[active]?.click();
		}
	});

	list.addEventListener("pointermove", (event) => {
		const target =
			event.target instanceof Element &&
			event.target.closest<HTMLAnchorElement>(".search-option");
		if (target) setActive(options.indexOf(target), false);
	});

	// Close on a click outside the panel, and after choosing a result, which may only change the hash.
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
		else if (
			event.target instanceof Element &&
			event.target.closest(".search-option")
		)
			dialog.close();
	});
};
