---
title: Quick Start
section: Overview
order: 2
layout: doc.njk
permalink: /docs/quick-start/
---

{% from "macros/code.njk" import code %}

## Quick Start

The application is distributed as a single Docker Image. You can download and load it with a single command:

{{ code(language="sh", content="curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | bash") }}

This downloads the latest release of Amazing Hashbrown and loads it into your local Docker environment, tagged `amazing-hashbrown:latest`. To install a specific version instead of the latest, pass it after `-s --`:

{{ code(language="sh", content="curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | bash -s -- v1.5.0") }}

Once the image is loaded, head to [Docker](/docs/docker/) to run the container.


