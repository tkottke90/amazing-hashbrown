import syntaxHighlight from '@11ty/eleventy-plugin-syntaxhighlight';
import markdownIt from 'markdown-it';
import markdownItAdmon from 'markdown-it-admon';

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Controls the top-to-bottom order of sections in the docs sidebar. A
// section's `section:` frontmatter value must match an entry here to be
// placed by it; anything not listed sinks to the bottom, alphabetically
// among itself, so a new section never silently disappears.
const SECTION_ORDER = ['Overview', 'Configuration', 'LLM Wiki', 'Workspaces'];

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(syntaxHighlight);
  eleventyConfig.addPassthroughCopy('content/css');
  eleventyConfig.addPassthroughCopy('content/images');
  eleventyConfig.addPassthroughCopy('content/assets');

  // MkDocs-style admonitions (!!! note "Title" ... ). markdown-it-admon only
  // strips a title's quotes when they wrap an empty string, so quoted titles
  // are unquoted here before the block parser sees them.
  const markdownLibrary = markdownIt({ html: true }).use(markdownItAdmon);
  markdownLibrary.core.ruler.before('block', 'admonition-title-quotes', (state) => {
    state.src = state.src.replace(/^(!{3,}\s+\S+\s+)"(.*)"\s*$/gm, '$1$2');
    return true;
  });
  eleventyConfig.setLibrary('md', markdownLibrary);

  // Adds ids to h2/h3 headings in rendered doc content and returns a
  // table-of-contents array alongside the annotated html, so doc.njk can
  // render an "on this page" nav without a client-side pass over the DOM.
  eleventyConfig.addFilter('withToc', function (html) {
    if (!html) return { html: html || '', toc: [] };

    const toc = [];
    const seen = new Map();

    const annotated = html.replace(/<h([2-3])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      let id = slugifyHeading(text) || 'section';
      const count = seen.get(id) || 0;
      seen.set(id, count + 1);
      if (count > 0) id = `${id}-${count}`;

      toc.push({ level: Number(level), id, text });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    });

    return { html: annotated, toc };
  });

  eleventyConfig.addCollection('docsBySection', (collectionApi) => {
    const pages = collectionApi.getFilteredByGlob('content/docs/**/*.md');

    const sections = new Map();
    for (const page of pages) {
      const sectionName = page.data.section || 'Uncategorized';
      if (!sections.has(sectionName)) {
        sections.set(sectionName, []);
      }
      sections.get(sectionName).push(page);
    }

    for (const sectionPages of sections.values()) {
      sectionPages.sort((a, b) => {
        const orderA = a.data.order ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.data.order ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return (a.data.title || '').localeCompare(b.data.title || '');
      });
    }

    const sectionsArray = [...sections.entries()].map(([name, sectionPages]) => ({
      name,
      pages: sectionPages,
    }));

    sectionsArray.sort((a, b) => {
      const rankA = SECTION_ORDER.indexOf(a.name);
      const rankB = SECTION_ORDER.indexOf(b.name);
      const orderA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
      const orderB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

    return sectionsArray;
  });

  return {
    dir: {
      input: 'content',
      output: '_site',
      includes: '_includes',
    },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk',
    pathPrefix: process.env.ELEVENTY_PATH_PREFIX || '/',
  };
}
