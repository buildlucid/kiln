/**
 * The site's only script. Every page works without it: it adds search, copy buttons,
 * remembered sidebar sections, the "On this page" highlight and the benchmark tabs.
 */
import { initCopy } from "./copy.js";
import { initNav } from "./nav.js";
import { initSearch } from "./search.js";
import { initTabs } from "./tabs.js";
import { initToc } from "./toc.js";

initCopy();
initNav();
initSearch();
initTabs();
initToc();
