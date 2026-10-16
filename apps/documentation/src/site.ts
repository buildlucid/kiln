/** Details about the site, shared by templates (as the `site` global) and the build. */
export const site = {
	name: "Kiln",
	/** Where the site is published, with no trailing slash. Canonical links, the sitemap and llms.txt use it. */
	url: "https://kilnlang.com",
	tagline: "Fast, safe templates for server-rendered websites",
	package: "@lucidkiln/core",
	repository: "https://github.com/buildlucid/kiln",
	/** The docs source, for "Edit this page" links. */
	source:
		"https://github.com/buildlucid/kiln/blob/master/apps/documentation/src",
};
