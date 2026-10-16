const timers = new WeakMap<HTMLElement, number>();

/** Shows a tick, and says "Copied" to screen readers, for a moment after copying. */
const confirm = (button: HTMLElement) => {
	const label = button.dataset.label ?? button.getAttribute("aria-label") ?? "";
	button.dataset.label = label;
	button.dataset.copied = "";
	if (button.hasAttribute("aria-label"))
		button.setAttribute("aria-label", "Copied");
	const text = button.querySelector("[data-copy-page-label]");
	if (text) text.textContent = "Copied";
	clearTimeout(timers.get(button));
	timers.set(
		button,
		window.setTimeout(() => {
			delete button.dataset.copied;
			if (button.hasAttribute("aria-label"))
				button.setAttribute("aria-label", label);
			if (text) text.textContent = "Copy as Markdown";
		}, 1600),
	);
};

/** Fetches the page's Markdown inside the click, so Safari still allows the clipboard write. */
const copyMarkdown = async (url: string) => {
	const text = fetch(url).then(async (response) => {
		if (!response.ok) throw new Error(`Couldn't load ${url}`);
		return new Blob([await response.text()], { type: "text/plain" });
	});
	try {
		await navigator.clipboard.write([
			new ClipboardItem({ "text/plain": text }),
		]);
	} catch {
		await navigator.clipboard.writeText(await (await text).text());
	}
};

/**
 * Handles every copy button on the page.
 *
 * - `data-copy="text"` copies that text.
 * - `data-copy` with no value copies the code in the closest `[data-code]`.
 * - `data-copy-page="/docs/page.md"` copies the page as Markdown.
 */
export const initCopy = () => {
	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLElement>(
			"[data-copy], [data-copy-page]",
		);
		if (!button) return;
		try {
			if (button.dataset.copyPage) await copyMarkdown(button.dataset.copyPage);
			else
				await navigator.clipboard.writeText(
					button.dataset.copy ||
						(button.closest("[data-code]")?.querySelector("pre")?.textContent ??
							""),
				);
			confirm(button);
		} catch (error) {
			console.error(error);
		}
	});
};
