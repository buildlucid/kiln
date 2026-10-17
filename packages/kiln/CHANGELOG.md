# Changelog

All notable changes to `@lucidkiln/core` are listed here.

## Unreleased

- `check` and the language server warn about obsolete and inaccessible HTML: obsolete elements, images without `alt`, buttons without `type`, `html` without `lang`, a `tabindex` above 0, and ARIA attributes and roles that don't exist. Set levels with the new `htmlChecks` option. See [HTML checks](https://kilnlang.com/docs/tooling/html-checks/).
- More HTML checks: obsolete attributes, attribute values a browser would ignore (including `disabled="false"`), invalid language tags, iframes without `title`, viewports that block zooming, redundant roles, `aria-hidden` on focusable elements, skipped heading levels, nested interactive elements, and elements their parent can't hold. Nesting checks follow the template's branches and loops, and only report what is certain.

## 1.0.0 - 2026-10-17

- The first stable release. Read the [documentation](https://kilnlang.com/docs/) to get started.
