/**
 * Render data for every scenario. A seeded generator makes the data the same on every run, and some user-written
 * text includes characters that must be escaped, as real content does.
 */

const random = (() => {
	let seed = 20261015;
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
})();

const int = (min: number, max: number) =>
	min + Math.floor(random() * (max - min + 1));
const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
const times = <T>(count: number, make: (index: number) => T): T[] =>
	Array.from({ length: count }, (_, index) => make(index));

const WORDS =
	"kiln template render layout block async data fast safe component slot macro filter escape markup page site post author draft publish cache worker server edge node stream string number date locale theme section header footer grid card table query search result price basket product order review rating guide release note change field value".split(
		" ",
	);

const words = (count: number) => times(count, () => pick(WORDS)).join(" ");
const sentence = (count: number) => {
	const text = words(count);
	return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
};
const paragraph = (sentences: number) =>
	times(sentences, () => sentence(int(6, 14))).join(" ");
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** An ISO date at midday UTC, so it shows the same day in every time zone. */
const day = (offset: number) =>
	new Date(Date.UTC(2026, 0, 1 + offset, 12)).toISOString();

const NAMES = [
	"Ada Lovelace",
	"Grace Hopper",
	"Alan Turing",
	"Seán O'Brien",
	"Zoë Müller",
	"Tim Berners-Lee",
	"Margaret Hamilton",
	"Linus <Torvalds>",
];

/** User-written text, with the characters that need escaping. */
const UNTRUSTED = [
	'Great post! I tried this with "strict mode" & it worked first time.',
	"Does this work with <script> tags? Asking for a friend.",
	"Thanks - this saved me hours. 5 > 3 & 2 < 4, as they say.",
	"I'd love to see a follow-up on caching & invalidation.",
	"Typo in the 3rd example: it says <h2> but should be <h3>.",
];

const site = {
	name: "Field Notes",
	url: "https://example.com",
	nav: [
		{ title: "Home", url: "/" },
		{ title: "Blog", url: "/blog/" },
		{ title: "Guides", url: "/guides/" },
		{ title: "Changelog", url: "/changelog/" },
		{ title: "About", url: "/about/" },
		{ title: "Contact", url: "/contact/" },
	],
	footer: [
		{ title: "Privacy", url: "/privacy/" },
		{ title: "Terms", url: "/terms/" },
		{ title: "RSS", url: "/rss.xml" },
	],
	year: 2026,
};

const author = (index: number) => ({
	id: `author-${index}`,
	name: NAMES[index % NAMES.length]!,
	url: `/authors/${index}/`,
	bio: sentence(16),
});

const authors = times(8, author);

const postSummary = (index: number) => {
	const title = sentence(int(4, 8)).slice(0, -1);
	return {
		title,
		url: `/blog/${slug(title)}-${index}/`,
		publishedAt: day(index * 3),
		excerpt: paragraph(2),
		authorId: authors[index % authors.length]!.id,
	};
};

/** A blog post page: layout, partials, trusted body HTML, tags, related posts and escaped comments. */
export const blogPost = {
	site,
	current: "/blog/",
	post: {
		...postSummary(0),
		readingTime: 7,
		author: authors[3]!,
		body: times(
			10,
			(index) =>
				`${index % 4 === 3 ? `<h2>${sentence(4).slice(0, -1)}</h2>` : ""}<p>${paragraph(int(3, 6))}</p>`,
		).join("\n"),
		tags: times(5, () => pick(WORDS)),
	},
	related: times(6, (index) => postSummary(index + 1)),
	comments: times(20, (index) => ({
		author: NAMES[index % NAMES.length]!,
		postedAt: day(200 + index),
		body: UNTRUSTED[index % UNTRUSTED.length]!,
	})),
};

const feature = () => ({
	icon: pick(["bolt", "shield", "cloud", "code", "layers", "clock"]),
	title: sentence(3).slice(0, -1),
	text: sentence(18),
});

const SECTIONS = {
	hero: () => ({
		type: "hero" as const,
		heading: sentence(6).slice(0, -1),
		text: paragraph(2),
		image: { src: "/images/hero.avif", alt: sentence(5) },
		actions: [
			{ label: "Get started", url: "/docs/", primary: true },
			{ label: "View on GitHub", url: "https://github.com", primary: false },
		],
	}),
	features: () => ({
		type: "features" as const,
		heading: sentence(4).slice(0, -1),
		items: times(6, feature),
	}),
	testimonials: () => ({
		type: "testimonials" as const,
		heading: "What people say",
		items: times(3, (index) => ({
			quote: UNTRUSTED[index]!,
			name: NAMES[index + 2]!,
			role: `${pick(["Lead", "Senior", "Staff"])} developer`,
		})),
	}),
	pricing: () => ({
		type: "pricing" as const,
		heading: "Pricing",
		plans: [
			{ name: "Hobby", price: 0, features: times(4, () => words(3)) },
			{ name: "Team", price: 49.5, features: times(6, () => words(3)) },
			{ name: "Business", price: 1250, features: times(8, () => words(3)) },
		].map((plan, index) => ({ ...plan, featured: index === 1 })),
	}),
	faq: () => ({
		type: "faq" as const,
		heading: "Questions",
		items: times(8, () => ({
			question: `${sentence(int(5, 9)).slice(0, -1)}?`,
			answer: paragraph(2),
		})),
	}),
	cta: () => ({
		type: "cta" as const,
		heading: sentence(5).slice(0, -1),
		text: sentence(12),
		action: { label: "Start building", url: "/signup/" },
	}),
};

/** A CMS page built from a list of sections. Each section's type picks the template that renders it. */
export const landingPage = {
	site,
	current: "/",
	page: {
		title: "Build faster websites",
		sections: (
			[
				"hero",
				"features",
				"testimonials",
				"pricing",
				"faq",
				"features",
				"testimonials",
				"faq",
				"cta",
				"cta",
			] as const
		).map((type) => SECTIONS[type]()),
	},
};

/** A shop category page: a reusable card rendered once per product. */
export const productGrid = {
	category: "Ceramics",
	products: times(48, (index) => {
		const name = sentence(int(2, 4)).slice(0, -1);
		const price = int(500, 25000) / 100;
		return {
			id: `p${index}`,
			name,
			url: `/shop/${slug(name)}-${index}/`,
			image: { src: `/images/products/${index}.avif`, alt: name },
			price,
			salePrice: index % 5 === 0 ? Math.round(price * 70) / 100 : null,
			rating: int(1, 5),
			reviewCount: int(0, 900),
			badges:
				index % 7 === 0 ? ["New", "Limited"] : index % 3 === 0 ? ["New"] : [],
			inStock: index % 9 !== 0,
		};
	}),
};

/** An admin table of users. */
export const dataTable = {
	columns: ["ID", "Name", "Email", "Role", "Status", "Score"],
	rows: times(500, (index) => {
		const name = NAMES[index % NAMES.length]!;
		return {
			id: index + 1,
			name,
			email: `${slug(name)}${index}@example.com`,
			role: pick(["Admin", "Editor", "Author", "Viewer"]),
			active: random() > 0.3,
			score: int(0, 1000),
		};
	}),
};

/** A search results page that leans on filters. */
export const searchResults = {
	query: "async & <templates>",
	total: 18342,
	results: times(25, (index) => ({
		title: sentence(int(4, 9)).slice(0, -1),
		url: `/docs/${slug(words(3))}-${index}/`,
		category: pick(["Guide", "Reference", "Blog", "Changelog"]),
		excerpt: paragraph(3),
		tags: times(int(1, 5), () => pick(WORDS)),
		author: index % 4 === 0 ? null : { name: NAMES[index % NAMES.length]! },
	})),
};

const posts = times(10, (index) => postSummary(index + 10));
const categories = [
	"Guides",
	"Releases",
	"Performance",
	"Security",
	"Community",
];

/** How long each CMS data function waits, about as long as a query to a database near the server takes. */
export const CMS_LATENCY_MS = 2;

const later = <T>(value: T) =>
	new Promise<T>((resolve) => setTimeout(resolve, CMS_LATENCY_MS, value));

/** Blog posts in the CMS, newest first. */
const blog = times(6, (index) => {
	const summary = postSummary(35 - index);
	return {
		...summary,
		slug: slug(summary.title),
		author: authors[index % authors.length]!,
		body: times(6, () => `<p>${paragraph(int(3, 5))}</p>`).join("\n"),
	};
});

const collections: Record<string, typeof blog> = { blog };

const menus: Record<string, typeof site.nav> = {
	header: site.nav,
	footer: site.footer,
};

/**
 * The async functions templates call. The async data scenario's resolve straight away, as data from an in-memory
 * cache would, so it measures the cost of waiting. The CMS data scenario's stand in for a headless CMS's document
 * API, and each waits `CMS_LATENCY_MS`.
 */
export const asyncFunctions = {
	latestPosts: async (limit: number) => posts.slice(0, limit),
	author: async (id: string) => authors.find((item) => item.id === id) ?? null,
	categories: async () => categories,
	/** One document from a collection, by its slug. */
	document: (collection: string, slug: string) =>
		later(collections[collection]?.find((item) => item.slug === slug) ?? null),
	/** The newest documents in a collection. */
	documents: (collection: string, limit: number) =>
		later(collections[collection]?.slice(0, limit) ?? []),
	/** A navigation menu by name, such as `header`. */
	navigation: (name: string) => later(menus[name] ?? []),
};

/** The async data scenario passes only the site. Templates load the rest. */
export const asyncData = { site, current: "/blog/" };

/** The CMS data scenario passes the site's name and the post's slug, as a router would. Templates load the rest. */
export const cmsData = {
	site: { name: site.name, year: site.year },
	slug: blog[2]!.slug,
	current: "/blog/",
};
