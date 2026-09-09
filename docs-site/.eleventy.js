import syntaxHighlight from '@11ty/eleventy-plugin-syntaxhighlight';

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(syntaxHighlight);
  eleventyConfig.addPassthroughCopy('content/css');

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

    return [...sections.entries()].map(([name, sectionPages]) => ({
      name,
      pages: sectionPages,
    }));
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
