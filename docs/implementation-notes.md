# Implementation notes

## M0 and M1 — document core and change ledger

Decisions taken while turning `design-spec.md` into code, where the code departs from the spec, and
what is knowingly left undone. This is the record the spec's "next engineering artifact" section
asks for. Sections are added as each milestone lands.

---

## Decisions

### Raw SQL over an ORM

The spec names PostgreSQL but not an access layer. `pg` with plain SQL migrations was chosen over
Prisma for three reasons: no code-generation step in the build (so CI compiles without a reachable
database), direct control over the `pgvector` column types M4 will need, and a schema file that
reads as the spec's schema rather than as a translation of it.

### Two stores behind one interface

`DATABASE_URL` selects PostgreSQL; its absence selects a JSON file store. The file store is not a
toy — it is transactional per document, validates revisions the same way, and is what the test
suite exercises — but it is for local drafting, not deployment. Everything above `src/store` is
unaware of which one is active.

### Save and ledger append are one operation

`PUT /api/documents/:id` accepts the new content, the expected revision and the accompanying
changes together, and writes the document revision, the version snapshot, the node records and the
ledger entries in a single transaction. Splitting these across two endpoints would allow a ledger
that disagrees with the document it describes.

### Optimistic concurrency, not last-write-wins

A save carries the revision it was based on. A mismatch returns HTTP 409 rather than overwriting.
Real collaboration is an M8 concern (Yjs); until then, two tabs on one document must not silently
destroy each other's work.

### Node revision ≠ document revision

`document_nodes.revision` records when *that node's content* last changed. An untouched paragraph
keeps its revision when its neighbours are edited, which is what makes "which paragraphs are stale"
answerable in M4 without diffing whole snapshots.

### Heuristic classification now, model classification later

The spec assigns change classification to M5, using the fast model. M1 assigns it with local rules
instead (`src/core/classify.ts`): normalisation for typographical edits, pattern sets for citations,
cross-references, modal verbs and numbers. It costs nothing, it makes "hide typographical changes"
work immediately, and M5 can overwrite the field with a model judgement. `factual_assertion` is
never emitted locally — no honest local rule establishes it.

### Identity on split: first half keeps the ID

Splitting a paragraph copies its attributes onto both halves, so both briefly claim the same ID.
The node appearing **first in reading order** keeps it. This matches the author's intent: the
opening half is a continuation of the paragraph that existed, and the remainder is new.

The same rule de-duplicates pasted blocks, which also arrive carrying their source IDs.

ID assignment is excluded from the undo stack (`addToHistory: false`) — it is bookkeeping about an
edit, not an edit.

### The aggregator takes time as an argument

`ChangeAggregator` has no timers inside it. The caller supplies `now`, which is what makes the
quiet-period behaviour testable at all, and keeps the class usable server-side later (for batch
import diffing) as well as in the browser.

### Authentication deferred, attribution not

There is no identity provider yet, so every change is attributed to `usr_local`. The `author_id`
column is populated from day one so that adding OIDC later is a change of value, not of schema.

---

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| `change.operation` includes `move` | `move` is defined but never emitted | Reliable move detection needs relative-order comparison, not position hints. Inserting a paragraph shifts every later position, which would generate a flood of false moves. Deferred rather than done badly. |
| DOCX baseline includes images, footnotes, comments | Headings, paragraphs, bold/italic/underline/strike, inline code, links, lists, tables, quotes, code blocks, rules | Image alt text is preserved so prose is not lost. The rest awaits M8; per the spec, DOCX fidelity must not block the change-intelligence workflow. |
| Embeddings, summaries, suggestions, decisions tables | Not created | M4/M3/M7 concerns. The migration covers only what M0–M1 writes; the full-text index is included because it is free to add now. |
| Vector search | Not present | `pgvector` arrives with M4. Nothing in the current schema pre-empts it. |

---

## Known limitations

- **Whole-document flatten on every transaction.** `flattenBlocks` walks the entire document on
  each editor update to feed the aggregator. For a book-length manuscript this is the first thing
  that will need attention — most likely by mapping ProseMirror's step ranges to the touched blocks
  instead of rescanning. It is correct today, not fast at scale.
- **Change classification is lexical.** It cannot tell a terminology preference from a substantive
  redefinition; it only sees which words moved. That is the honest limit of a zero-token rule set.
- **The file store keeps 25 version snapshots per document** (plus every checkpoint revision).
  PostgreSQL keeps all of them.
- **No lockfile is committed yet.** CI runs `npm install`; once dependency versions are confirmed
  against a real registry, `package-lock.json` should be committed and CI switched to `npm ci`.
- **The editor sends the whole document on save.** Fine at this size; a delta protocol belongs with
  collaboration work, not before it.

---

## What M2 will need from this

The M2 Context Builder should be able to assemble a paragraph-level context package without any new
document infrastructure:

- `flattenBlocks` gives reading order, so previous/next block lookup is a single index step;
- `chapterIndex` gives the enclosing chapter for section-level context;
- `document_nodes.revision` tells it which summaries are stale;
- the ledger gives recent changes near the selection;
- `src/ai/gateway.ts` gives tier-based routing with no provider knowledge above it.

The one deliberately missing piece is the summaries table — M4 builds it, and M2 should degrade to
neighbouring paragraphs alone until then rather than sending whole chapters.

---

# M2 — Chat with selection

## Decisions

### The client never chooses the context

`POST /api/ai/ask` takes a document ID, a block ID, the selected text and a question. Everything
else - which neighbours to include, how much structure to describe, what to leave out - is decided
server-side by `src/ai/context-builder.ts`. A client that could choose its own context would make
the token-economy guarantees unenforceable and would leak the whole document the first time someone
wrote a convenient wrapper.

### The context digest is a record, not a debug aid

Every user turn stores the exact parts that were sent, their token counts, the share of the document
they represent, and what was withheld. The spec lists "Show AI context" as a privacy control; that
only means something if the record is what actually left the machine, so it is persisted with the
message rather than recomputed for display.

### Follow-ups do not resend the surroundings

The first turn carries the neighbouring paragraphs and the structural path. On a follow-up those are
already in the replayed conversation, so only the selection is re-sent and the rest is listed as
omitted. Paying twice for the same tokens is exactly the failure the token-economy section warns
about.

### Missing context is named, never faked

Hierarchical summaries (M4) and decisions (M7) are part of the spec's context package and do not
exist yet. Rather than silently omitting them, the digest lists them as withheld with the milestone
that will supply them - so a thin answer is legible as missing infrastructure rather than as a
document with no structure.

### The model is called before anything is written

A provider failure would otherwise leave a user turn in the conversation with no answer, and the
next follow-up would replay a broken exchange. Nothing is persisted until the completion returns.

### Token counts live on the answer only

The provider reports input tokens for the whole request. Storing an estimate on the question turn as
well would double-count every conversation. The question turn carries the digest; the answer turn
carries the real usage.

### Model routing by action

`ask` goes to the reasoning tier - it is judgement about the author's own argument. `explain` goes to
the fast tier - it is comprehension. Both model IDs are environment-overridable, and the tier names
never leak above `src/ai`.

## Enforced structurally, not by convention

`tests/architecture.test.ts` asserts over the dependency graph that:

- `src/core`, `src/editor`, `src/store` and `src/formats` cannot reach `src/ai` or any provider SDK,
  so no editing path can acquire a model call by accident;
- `src/ai` cannot reach `src/store`, so model output has no write path to the document.

These are the two design rules that the product's credibility rests on. A test over imports catches
the regression at the moment someone introduces it, rather than on an invoice.

## Known limitations

- **The structural path stands in for the briefs.** Until M4, "Where this sits" is the document
  title plus the enclosing chapter and section headings. It is honest but thin: a question whose
  answer depends on Chapter 7 will be answered with "I would need to see that section".
- **One conversation per block is surfaced.** The store holds many; the sidebar resumes the most
  recent. A conversation picker belongs with the M8 sidebar work.
- **No streaming.** Answers arrive whole. For reasoning-tier requests on long passages this is a
  visible wait; streaming is a UI change, not an architectural one, and can land any time.
- **Token estimates are four-characters-per-token.** Good enough to hold a budget, wrong by a few
  per cent per language. The provider's real count is recorded alongside it.
