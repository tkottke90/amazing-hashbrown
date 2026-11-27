import type { Schema } from 'hast-util-sanitize';

/**
 * The Markdown Sanitize Schema (ADR-0071, GLOSSARY.md "Markdown Rendering &
 * Inline SVG"). Built by explicit enumeration of exactly what this app's
 * Markdown pipeline already produces — CommonMark, GFM, and
 * `rehype-highlight`'s own injected token `<span>`s — plus the
 * newly-supported SVG tags, rather than inheriting `rehype-sanitize`'s own
 * `defaultSchema`. Inheriting it would silently resurface ~24 raw-HTML tags
 * with no CommonMark/GFM equivalent (`details`/`summary`, `kbd`, `q`,
 * `ruby`, ...) the instant raw-HTML parsing is turned on for SVG's sake.
 */

// Shared presentation attributes for most SVG shape/container elements.
// Kept as one list rather than hand-tuned per tag, so the allowlist stays a
// single auditable surface (ADR-0071).
const SVG_SHARED_ATTRIBUTES = [
  'className',
  'id',
  'fill',
  'stroke',
  'strokeWidth',
  'strokeDashArray',
  'strokeLineCap',
  'strokeLineJoin',
  'opacity',
  'fillOpacity',
  'strokeOpacity',
  'transform',
  'clipPath',
] as const;

// Every SVG tag except `svg` itself requires an `svg` ancestor (see
// `ancestors` below) — an orphan `<path>` typed outside any `<svg>` strips
// rather than rendering as a meaningless element. `style` is included here
// (not among the unconditional base tags) so it's schema-allowed only
// inside an SVG, which the SVG Sandbox (ADR-0072) then mounts in an
// isolated shadow root — unreachable anywhere else in a Markdown message.
const SVG_ANCESTOR_TAGS = [
  'path',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'g',
  'defs',
  'use',
  'symbol',
  'text',
  'tspan',
  'title',
  'desc',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'stop',
  'marker',
  'animate',
  'animateTransform',
  'animateMotion',
  'set',
  'style',
] as const;

// ---- The shared SVG subset (ADR-0071) ---------------------------------------
// One enumeration, two compositions: `markdownSanitizeSchema` (SVG inside
// Markdown) and `svgSanitizeSchema` (an SVG Widget's SVG Source) both build
// from these constants, so the SVG allowlist stays a single auditable
// surface instead of drifting apart across two consumers.

export const SVG_ANCESTORS: NonNullable<Schema['ancestors']> = Object.fromEntries(
  SVG_ANCESTOR_TAGS.map((tag) => [tag, ['svg']]),
);

// `id`/`name` deliberately dropped from clobber-protection (ADR-0072) so
// `<use href="#id">` resolves — the SVG Sandbox's shadow root isolates any
// id-clobbering effect from the app's real `window`/`document` globals.
// `ariaDescribedBy`/`ariaLabelledBy` stay protected.
export const SVG_CLOBBER: string[] = ['ariaDescribedBy', 'ariaLabelledBy'];

export const SVG_TAG_NAMES: string[] = ['svg', ...SVG_ANCESTOR_TAGS];

export const SVG_ATTRIBUTES: NonNullable<Schema['attributes']> = {
  svg: ['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'className', 'id'],
  path: ['d', ...SVG_SHARED_ATTRIBUTES],
  circle: ['cx', 'cy', 'r', ...SVG_SHARED_ATTRIBUTES],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...SVG_SHARED_ATTRIBUTES],
  ellipse: ['cx', 'cy', 'rx', 'ry', ...SVG_SHARED_ATTRIBUTES],
  line: ['x1', 'y1', 'x2', 'y2', ...SVG_SHARED_ATTRIBUTES],
  polyline: ['points', ...SVG_SHARED_ATTRIBUTES],
  polygon: ['points', ...SVG_SHARED_ATTRIBUTES],
  g: [...SVG_SHARED_ATTRIBUTES],
  defs: ['id', 'className'],
  symbol: ['viewBox', 'preserveAspectRatio', 'id', 'className'],
  // href restricted to local/fragment references only (no scheme at all,
  // same-document references like `#icon`) — an SVG `<use>` pointing at
  // an external URL is a tracking-pixel/read-receipt vector on render,
  // with zero script execution required (ADR-0071). This is a tag-scoped
  // `attributes` regex, not the global `protocols` field — `protocols` is
  // keyed by attribute name across every tag, so setting it on `href`
  // would also restrict `<a href>`, which must stay unrestricted.
  use: [['href', /^#/], 'x', 'y', 'width', 'height', 'transform', 'className', 'id'],
  text: ['x', 'y', 'fontSize', 'fontFamily', 'textAnchor', 'fill', 'stroke', 'className', 'id'],
  tspan: ['x', 'y', 'fontSize', 'fontFamily', 'textAnchor', 'fill', 'stroke', 'className', 'id'],
  title: ['id', 'className'],
  desc: ['id', 'className'],
  clipPath: ['id', 'className'],
  mask: ['id', 'className'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'id', 'className'],
  radialGradient: ['cx', 'cy', 'r', 'gradientUnits', 'gradientTransform', 'id', 'className'],
  stop: ['offset', 'stopColor', 'stopOpacity', 'className'],
  marker: [
    'markerWidth',
    'markerHeight',
    'refX',
    'refY',
    'orient',
    'markerUnits',
    'viewBox',
    'preserveAspectRatio',
    'id',
    'className',
  ],
  // SMIL animation elements are allowed structurally with no
  // duration/repeat-count enforcement (ADR-0071) — a sanitize schema can
  // only allow/deny tags and attributes, not validate their values.
  // `href` stays local-fragment-only, same rule as `use`.
  animate: [
    ['href', /^#/],
    'attributeName',
    'dur',
    'repeatCount',
    'repeatDur',
    'begin',
    'values',
    'from',
    'to',
    'keyTimes',
    'calcMode',
    'id',
    'className',
  ],
  animateTransform: [
    ['href', /^#/],
    'attributeName',
    'dur',
    'repeatCount',
    'repeatDur',
    'begin',
    'values',
    'from',
    'to',
    'keyTimes',
    'calcMode',
    'id',
    'className',
  ],
  animateMotion: [
    ['href', /^#/],
    'dur',
    'repeatCount',
    'repeatDur',
    'begin',
    'keyTimes',
    'calcMode',
    'id',
    'className',
  ],
  set: [['href', /^#/], 'attributeName', 'to', 'begin', 'dur', 'id', 'className'],
  // `<style>`'s text content is never parsed/validated by this schema —
  // only reachable at all with an `svg` ancestor (see `ancestors`), and
  // CSS-scoped to that SVG's own shadow root once mounted by the SVG
  // Sandbox (ADR-0072), not by anything this schema does.
  style: [],
};

export const markdownSanitizeSchema: Schema = {
  tagNames: [
    // CommonMark
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'blockquote',
    'pre',
    'code',
    'a',
    'img',
    'em',
    'strong',
    'ul',
    'ol',
    'li',
    'br',
    // GFM
    'del',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'input',
    // rehype-highlight's injected syntax-highlighting token span
    'span',
    ...SVG_TAG_NAMES,
  ],

  attributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    // Matches the existing convention for a fenced code block's
    // `language-*` info-string class — restricted by regex, not a bare
    // wildcard, so this entry can't be widened into a general className
    // escape hatch.
    code: [['className', /^language-./]],
    span: [['className', /^(language-|hljs)/]],
    input: [['type', 'checkbox'], 'checked', 'disabled'],

    ...SVG_ATTRIBUTES,
  },

  // `<a>` keeps the ordinary external-link protocol list a plain Markdown
  // link already gets today — unaffected by the svg-only href restriction
  // above, since that lives in `attributes` (tag-scoped), not here.
  protocols: {
    href: ['http', 'https', 'mailto', 'tel'],
    src: ['http', 'https'],
  },

  ancestors: SVG_ANCESTORS,

  // `id`/`name` deliberately dropped from clobber-protection (ADR-0072) so
  // `<use href="#id">` resolves — the SVG Sandbox's shadow root isolates
  // any id-clobbering effect from the app's real `window`/`document`
  // globals, so the protection this would normally justify keeping isn't
  // needed here. `ariaDescribedBy`/`ariaLabelledBy` stay protected.
  clobber: SVG_CLOBBER,
};

/**
 * The sanitize schema for an SVG Widget's SVG Source (GLOSSARY.md "SVG
 * Widget"): the SVG subset only — none of Markdown's own tags (`p`, `a`,
 * `img`, `input`, `span`, ...) — with the same ancestor, `id`-clobber and
 * URL rules as `markdownSanitizeSchema` (ADR-0071/0072). A disallowed tag is
 * unwrapped, not dropped, so its text survives into the tree; callers decide
 * validity from the resulting shape (see `parseSvgSource`), not from this
 * schema alone.
 */
export const svgSanitizeSchema: Schema = {
  tagNames: SVG_TAG_NAMES,
  attributes: SVG_ATTRIBUTES,
  ancestors: SVG_ANCESTORS,
  clobber: SVG_CLOBBER,
};
