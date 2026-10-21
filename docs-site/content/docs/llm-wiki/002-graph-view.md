---
title: Graph View
section: LLM Wiki
order: 2
layout: doc.njk
---

## Graph View

The graph view allows a user to traverse the wiki information, view connections between documents. 

<figure class="flex flex-col items-center text-center">
  <img src="{{ '/assets/wiki-graph-view.png' | url }}" alt="Wiki graph view">
  <figcaption>Wiki graph view</figcaption>
</figure>


## Selecting a File

You can interact with the graph, hovering over a node will show you the Wiki, the Type, and a list of the tags assigned to that particular document:

<figure class="flex flex-col items-center text-center">
  <img src="{{ '/assets/wiki-graph-node-hover.png' | url }}" alt="Hovering a graph node shows a card with its title, tags, and an Open in editor button">
  <figcaption>Example: Wiki Graph Card</figcaption>
</figure>

Clicking on the "_Open in Editor_" button, switches to the [Document Viewer](./003-document-view.md) loads the file you selected in the graph.

## Filtering Nodes

Each wiki has a colored toggle chip above the graph. Click a chip to hide that wiki's nodes and edges — the chip dims and the graph re-lays itself out around the remaining wikis. Click it again to bring it back.

<figure class="flex flex-col items-center text-center">
  <img src="{{ '/assets/wiki-graph-domain-toggle.png' | url }}" alt="Wiki toggle chips above the graph, with the comfy-ui chip dimmed and its nodes hidden from the graph">
  <figcaption>Example: Toggling a wiki off</figcaption>
</figure>