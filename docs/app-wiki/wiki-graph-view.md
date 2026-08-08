# Wiki Graph View

The Wiki view (`/wiki`) has two modes: **Graph** and **Document**. The Graph view renders all wiki pages as an interactive force-layout graph powered by D3, giving you a spatial map of your knowledge base.

## Nodes

Each node represents one wiki page. Nodes are colored by page type:

- **Entity pages** — people, projects, products, organizations
- **Concept pages** — ideas, techniques, definitions
- **Query pages** — recorded questions and their answers
- **Source files** — raw imported documents (shown when "include sources" is enabled in the toolbar)

Node size reflects the number of connections — heavily linked pages appear larger.

## Edges

Edges represent relationships between pages:

- **references** — a `[[wikilink]]` from one page to another
- **contradicts** — declared in a page's frontmatter when it disputes another page's content
- **derived_from** — connects a structured page back to the raw source file it was extracted from

## Interacting With the Graph

- **Click a node** — opens the page in Document view
- **Drag a node** — repositions it (the layout re-stabilizes around it)
- **Scroll / pinch** — zoom in and out
- **Domain filter dropdown** — narrows the graph to pages in a single wiki domain, useful when you have many domains and want to focus on one area

## What the Graph Is Good For

- **Orphan pages** — nodes with no edges haven't been linked from anywhere, which may mean they're forgotten or redundant
- **Dense clusters** — tightly connected topic groups often signal a coherent area of your knowledge base worth reviewing
- **Contradiction clusters** — contradiction edges in one area flag conflicting information to resolve

Switch to **Document view** to browse and read individual pages. See [[How the Wiki Works]] for more on page types and structure.
