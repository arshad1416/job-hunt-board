/**
 * Job-description extraction — pure functions, no network.
 *
 * Order of preference:
 *   1. schema.org JobPosting JSON-LD. Both LinkedIn and Indeed emit this,
 *      and it often survives on pages whose visible body is behind a wall.
 *   2. A JobPosting-ish content container in the HTML.
 *   3. <meta name="description"> — short, but honest.
 *
 * Returns null rather than guessing. A wrong description is worse than
 * none: it feeds straight into the resume prompt.
 */

const MIN_USEFUL_CHARS = 120;

/** Decode the entity subset that actually shows up in job postings. */
export function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** HTML → readable plain text, preserving paragraph and bullet breaks. */
export function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\s*(br|hr)\s*\/?>/gi, '\n');
  t = t.replace(/<\/\s*(p|div|section|h[1-6]|tr)\s*>/gi, '\n\n');
  t = t.replace(/<\s*li[^>]*>/gi, '\n• ');
  t = t.replace(/<\/\s*(li|ul|ol)\s*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t ]+/g, ' ');
  t = t.replace(/ *\n */g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** Walk any nested JSON looking for a JobPosting node with a description. */
function findJobPosting(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findJobPosting(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('JobPosting') && typeof node.description === 'string') {
    return node.description;
  }
  for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
    if (node[key]) {
      const hit = findJobPosting(node[key], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function fromJsonLd(html) {
  const blocks = [...String(html).matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  for (const [, raw] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue; // a malformed block is not a reason to abandon the rest
    }
    const desc = findJobPosting(parsed);
    if (desc) {
      const text = htmlToText(desc);
      if (text.length >= MIN_USEFUL_CHARS) return text;
    }
  }
  return null;
}

/** Containers the major boards wrap the JD body in. */
const CONTAINER_PATTERNS = [
  /<div[^>]+class=["'][^"']*(?:show-more-less-html__markup|description__text)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  /<div[^>]+id=["'](?:jobDescriptionText|job-details)["'][^>]*>([\s\S]*?)<\/div>/i,
  /<section[^>]+class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/section>/i
];

export function fromContainer(html) {
  for (const re of CONTAINER_PATTERNS) {
    const m = re.exec(html);
    if (m) {
      const text = htmlToText(m[1]);
      if (text.length >= MIN_USEFUL_CHARS) return text;
    }
  }
  return null;
}

export function fromMetaDescription(html) {
  const m =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (!m) return null;
  const text = decodeEntities(m[1]).trim();
  return text.length >= MIN_USEFUL_CHARS ? text : null;
}

/**
 * Best-effort JD body from a fetched posting page.
 * @returns {{text: string, via: string}|null}
 */
export function extractJobDescription(html) {
  if (!html) return null;
  const attempts = [
    ['json-ld', fromJsonLd],
    ['container', fromContainer],
    ['meta', fromMetaDescription]
  ];
  for (const [via, fn] of attempts) {
    const text = fn(html);
    if (text) return { text, via };
  }
  return null;
}
