# TextRippleAI

**A change-aware AI writing environment for long-form documents** — Word-like editing combined
with structured change provenance, so the document knows *what* changed, *where*, and *why*.

The differentiator is not document generation. It is the ability to reason over the **evolution**
of a document: books, theses, standards, specifications, policies, regulations and reports, where a
wording change in Chapter 3 quietly invalidates a conclusion in Chapter 8.

> Full design: [`docs/design-spec.md`](docs/design-spec.md).
> Implementation decisions and known limits: [`docs/implementation-notes.md`](docs/implementation-notes.md).

---

## Status: M0 + M1 complete

This repository currently implements the first two milestones of the plan — the document core and
change intelligence. **No LLM is called anywhere in the editing path.** The AI gateway exists and is
configurable, but nothing sends document text to a model yet; that begins at M2.

| Milestone | Scope | State |
|---|---|---|
| **M0** | Document core: Tiptap editor, persistent node IDs, revisions, DOCX/Markdown import & export | ✅ built |
| **M1** | Change intelligence: Change Aggregator, Change Ledger, checkpoints, change review | ✅ built |
| M2 | Chat with selection — Context Builder, AI sidebar | gateway scaffolded, not wired |
| M3 | AI editing — suggestions with accept/reject and provenance | not started |
| M4 | Semantic index — summaries, pgvector embeddings, hybrid retrieval | schema groundwork only |
| M5 | Impact analysis — candidate retrieval, ranking, impact briefing | not started |
| M6–M8 | Propagation, decision memory, advanced document capabilities | not started |

### What works today

- Create a document, or import a `.docx`, `.md`, `.txt` or `.json` manuscript.
- Edit it in a Word-like editor with headings, lists, tables, links and code blocks.
- Every paragraph carries a **persistent ID** that survives edits, splits, saves and reloads.
- Typing a word produces **one** ledger entry, not one per keystroke.
- Manual rewrites are captured with before/after values, a content hash and a heuristic
  classification (typographical, terminology, requirement, citation, cross-reference, …).
- Create named **checkpoints** ("Methodology approved") and list everything that changed since one,
  broken down by chapter, with typographical noise filterable.
- Export back to DOCX, Markdown, plain text or canonical JSON.

---

## Quick start

Requires **Node 20+**. No database and no API key are needed to run it.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Documents are stored as JSON under `.data/` (gitignored).

### Using PostgreSQL

```bash
cp .env.example .env      # then set DATABASE_URL
npm run db:migrate
npm run dev
```

`DATABASE_URL` alone switches the store; nothing else changes. The schema in `db/migrations/`
is the one from the design spec, including the full-text index that M4's hybrid retrieval needs.

### Configuring the AI gateway

Nothing calls it yet, but it is selectable now:

```bash
AI_PROVIDER=anthropic     # anthropic | openai | mock (default)
ANTHROPIC_API_KEY=...
# or
AI_PROVIDER=openai
OPENAI_API_KEY=...
```

`GET /api/ai/status` reports the configuration **without contacting any provider**, so checking
costs nothing. Anthropic serves no embedding model, so an Anthropic deployment borrows the OpenAI
embedding model when a key is present, and otherwise falls back to a deterministic stub.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit tests (Vitest) |
| `npm run db:migrate` | Apply `db/migrations/*.sql` (requires `DATABASE_URL`) |
| `npm run smoke` | End-to-end check against a running server |

---

## Architecture

```
src/core/      Pure domain logic - no React, no database, no provider.
               IDs, hashing, document model, diff, classification, Change Aggregator.
src/store/     Storage boundary. PostgresStore | FileStore behind one interface.
src/formats/   DOCX / Markdown / HTML / plain-text import and export.
src/editor/    Tiptap extensions and the client editing session.
src/ai/        Provider-independent gateway (Anthropic, OpenAI, deterministic mock).
src/app/       Next.js App Router pages and API routes.
src/components/ UI: editor pane, outline, review sidebar, status bar.
```

The dependency arrow points one way: `core` knows nothing about the editor, the store, the network
or any model. That is what lets the change model outlive all four.

### The three design rules that shape the code

1. **The document is authoritative.** AI output is never inserted silently; it becomes a proposal
   the author accepts. (Enforced structurally — there is no write path from a model to the document.)
2. **Editing and AI reasoning are separate.** Normal typing must never trigger a model request.
   The status bar reports `0 LLM calls this session` because that is architecturally true.
3. **Stable identity beats text position.** Paragraphs are addressed by persistent ID, never by
   character offset, because offsets are invalidated by the next edit.

### How change capture works

```
editor transaction
      ↓  (no LLM call)
flattenBlocks → ChangeAggregator.observe()
      ↓  grouped by: same block + same session + short interval
ChangeAggregator.drain()      ← quiet period elapsed
      ↓
save: PUT /api/documents/:id { content, expectedRevision, changes }
      ↓  one transaction
document revision + version snapshot + node records + Change Ledger entries
```

A checkpoint flushes everything pending before it is created, so no change can hide across a
review boundary.

---

## API

```
GET    /api/documents                      list
POST   /api/documents                      create
POST   /api/documents/import               create from an uploaded file
GET    /api/documents/:id                  load
PUT    /api/documents/:id                  save content + append changes (one transaction)
DELETE /api/documents/:id                  delete
GET    /api/documents/:id/changes          ledger, ?since=<checkpoint> &includeTrivial=false
GET    /api/documents/:id/checkpoints      list
POST   /api/documents/:id/checkpoints      create
GET    /api/documents/:id/export           ?format=docx|md|txt|json
GET    /api/ai/status                      gateway configuration (no provider call)
```

---

## Tests

The suite is written against the milestone acceptance criteria, not against the implementation:

- paragraph IDs survive edits; adding a paragraph does not renumber existing ones; a split re-keys
  only the second half; IDs survive a JSON round trip;
- typing a word creates one change, not thirteen; an undone edit creates none; editing one
  paragraph does not hold another paragraph's pending change open;
- a stale save is rejected rather than silently overwriting;
- changes since a checkpoint are exactly those made after it;
- DOCX/Markdown/HTML import assigns IDs and round-trips structure.

The Tiptap plugin is driven by a real editor under jsdom, so identity behaviour is tested
where it actually runs rather than only in the equivalent server-side helper. A separate
smoke test walks the whole workflow over HTTP against the built server - create, edit,
record, checkpoint, scope, filter, export, delete - and CI runs it after every build.

```bash
npm test
```

---

## Not in this milestone

Deliberately out of scope for M0–M1, per the spec's non-goals: real-time collaboration, perfect
Word round-trip fidelity, citation management, a knowledge graph, continuous AI monitoring,
autonomous rewriting, automatic propagation, desktop packaging, OCR. Images, footnotes and comments
are not yet part of the DOCX baseline — see `docs/implementation-notes.md`.
