/** Highlights the "On this page" link for the section being read. */
export const initToc = () => {
	const links = Array.from(
		document.querySelectorAll<HTMLAnchorElement>("[data-toc] a[href^='#']"),
	).filter((link) => link.hash !== "#content");
	const headings = links.map((link) =>
		document.getElementById(decodeURIComponent(link.hash.slice(1))),
	);
	if (!links.length) return;

	let current: HTMLAnchorElement | undefined;
	let queued = false;

	const update = () => {
		queued = false;
		const line = innerHeight * 0.25;
		const atBottom =
			innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
		let index = atBottom ? links.length - 1 : -1;
		if (!atBottom)
			headings.forEach((heading, n) => {
				if (heading && heading.getBoundingClientRect().top <= line) index = n;
			});
		const next = links[index];
		if (next === current) return;
		current?.removeAttribute("aria-current");
		next?.setAttribute("aria-current", "true");
		current = next;
	};

	addEventListener(
		"scroll",
		() => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(update);
		},
		{ passive: true },
	);
	update();
};
