# amazing-hashbrown

A local LLM agent harness: a persona knowledge base and autonomous assistant.

## Stack

- TypeScript everywhere
- [LangChain](https://js.langchain.com/) for LLM inference and streaming chat
- Node.js + Express for the REST API
- Preact for the web frontend
- Mocha for backend tests, Jest for frontend tests
- Knowledge bases organized by domain, following the LLM-Wiki pattern
- ESLint + Prettier
- npm workspaces

## Structure

```
api/                  Express REST API (TypeScript, LangChain agents)
  src/
    agents/           LangChain agent/chain definitions
    config/           Environment configuration
    knowledge-base/   Domain-organized knowledge bases (LLM-Wiki pattern)
    routes/           Express routes
    types/            Shared API types
  test/               Mocha tests

ui/                   Preact web frontend (TypeScript, Vite)
  src/
    components/       Reusable UI components
    pages/            Top-level views
    hooks/            Preact hooks
    services/         API client
  test/               Jest tests
```

## Getting started

```sh
npm install
cp .env.example .env

npm run dev:api   # start the API
npm run dev:ui    # start the frontend
```

## Scripts

- `npm run build` — build both workspaces
- `npm test` — run backend (Mocha) and frontend (Jest) tests
- `npm run lint` — lint all workspaces
- `npm run format` — format all workspaces with Prettier
