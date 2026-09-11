---
title: Quick Start
section: Overview
order: 2
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Quick Start

The application is distributed as a single Docker Image. You can download the image from the Github Release using CURL:

{{ code(language="sh", content="curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | sh") }}

This will download the latest release of Amazing Hashbrown, load it into your local Docker environment, and start the application. Once the application is running, you can access it at [http://localhost:3000](http://localhost:3000).


