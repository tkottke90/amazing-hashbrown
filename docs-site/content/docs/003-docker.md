---
title: Docker
section: Overview
order: 3
layout: doc.njk
permalink: /docs/docker/
---
{% from "macros/code.njk" import code %}

## Docker

!!! note "Image Required"
    This assumes you already have the application's image loaded locally as `amazing-hashbrown:latest` — run the [install script](/docs/quick-start/) first if you haven't.

    If you loaded or pulled the image some other way, `docker load`/`docker pull` restore it under its full registry name and version instead (e.g. `docker.artifacts.tdkottke.com/amazing-hashbrown:v1.7.0`) — run `docker images` to see the tag you actually have, then retag it to match the commands below: `docker tag docker.artifacts.tdkottke.com/amazing-hashbrown:v1.7.0 amazing-hashbrown:latest`.

The container keeps everything meant to persist (`config.yaml`, its SQLite database, wiki content, uploaded artifacts, skills, etc) under `/app/config` inside the image. Both examples below bind-mount a local folder to that path so your data survives container restarts and upgrades instead of disappearing with the container.

The container itself runs as a non-root user (uid/gid `1001`), not `root`. If the bind-mount folder doesn't exist yet, Docker creates it owned by `root` on first start, and the app fails writing its default `config.yaml` with a permissions error. Create the folder and hand it to that user once, before the first run:

{% call code(language="sh") %}
mkdir -p ./data
sudo chown -R 1001:1001 ./data
{% endcall %}

Then run the container using `docker run`:

{% call code(language="sh") %}
docker run -d \
  --name amazing-hashbrown \
  --restart unless-stopped \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/config" \
  amazing-hashbrown:latest
{% endcall %}

## Docker Compose

{% call code(language="yaml") %}
services:
  amazing-hashbrown:
    image: amazing-hashbrown:latest
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./data:/app/config
{% endcall %}

Save that as `docker-compose.yaml` next to the `./data` folder you created above (same ownership fix applies — Compose creates the bind mount the same way `docker run` does), then start it:

{% call code(language="sh") %}
docker compose up -d
{% endcall %}

### After the first start

The first boot writes a default `config.yaml` into `./data` with no LLM provider configured — the app comes up, but chat won't work until you add one. Edit `./data/config.yaml` and add a `providers` entry (see [Configuration](/docs/configuration/)), then restart:

{% call code(language="sh") %}
docker restart amazing-hashbrown
# or, for Compose:
docker compose restart
{% endcall %}

