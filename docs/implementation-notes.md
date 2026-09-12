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

---

# M3 — AI editing

## Decisions

### The server applies the proposal, not the client

Accepting a suggestion posts to the server, which loads the document, applies the replacement,
bumps the revision, writes the ledger entry and marks the proposal accepted - in one operation. The
client then adopts the result.

The alternative, letting the client edit the text and then report what it did, would make every
guarantee in this milestone advisory. Provenance that the client can author is not provenance.

### Acceptance is guarded twice

A proposal carries the block's text as it stood when the proposal was made. Acceptance checks both
that the document is still at the revision the author was reviewing (`RevisionConflictError`) and
that *this passage* still reads as it did (`SuggestionStaleError`). The second check is the
important one: revisions advance for edits anywhere in the document, but only the passage itself
determines whether the rewrite still makes sense. Applying a stale proposal would silently discard
whatever the author wrote in the meantime.

### Block granularity, with formatting preserved at the edges

A proposal replaces a whole block. That is the smallest unit whose meaning stands on its own and
the largest a reviewer takes in at a glance, and it keeps application unambiguous.

`spliceInlineText` keeps the marks on whatever prefix and suffix the rewrite leaves untouched, so
tightening the opening clause of a paragraph does not strip the hyperlink at the end of it. Only
the span that actually changed becomes plain text. A total rewrite legitimately loses inline
formatting, because there is nothing left to anchor it to.

### A rewritten paragraph is the same paragraph

The block keeps its ID and its node attributes through acceptance. That is what makes the edit
traceable afterwards, and what will let M5 ask "what else depends on this paragraph" without
needing to know it was once rewritten.

### The aggregator is told, not left to notice

After acceptance the editor content is replaced without emitting an update, and the session is
rebased onto the new revision (`ChangeAggregator.reset`). Otherwise the aggregator would see the
new text as a manual edit and write a second, human-attributed ledger entry for a change that was
already recorded as AI-accepted. Pending edits are flushed before acceptance so nothing is lost.

### The reply format is a contract

The model must return `<replacement>` and `<rationale>` sections. The replacement is applied
verbatim once accepted, so it has to be separable from commentary with certainty rather than by
guesswork. An untagged reply is treated as the replacement - a model that ignores the format still
produces something reviewable - but an empty one is an error. Silently proposing to delete a
paragraph is the worst available failure mode.

### Revision supersedes rather than overwrites

Asking for another attempt creates a new proposal pointing at its parent, and marks the parent
`revised`. Nothing is edited in place, so the sequence of attempts stays legible afterwards - which
matters when the question later becomes "why does this paragraph read the way it does".

### The mock provider honours the contract

When the system prompt asks for a tagged replacement, the deterministic stub returns one. That
keeps the entire propose → review → accept path exercisable in CI with no API key and no spend,
which is why the smoke test can assert the ledger provenance of an accepted rewrite.

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| Suggestion has `selection_start` / `selection_end` and replaces a selection | Recorded for provenance; the replacement covers the whole block | Splicing a model's plain-text output into the middle of a formatted inline range has no unambiguous reading. A narrower highlight is passed to the model as the place to concentrate. |
| `DISCUSSED` is a distinct path to `REVISED` | Both are available from `generated`; discussing is not required before revising | The author should not have to perform a step to get a second attempt. |

## Known limitations

- **No streaming.** A reasoning-tier rewrite of a long paragraph is a visible wait.
- **One proposal is applied at a time.** Accepting several in a batch would need a single revision
  covering all of them; each acceptance currently makes its own.
- **A rewrite cannot split or merge paragraphs.** The unit is a block, so restructuring is still
  manual work.
- **Formatting inside a fully rewritten paragraph is lost**, as described above.
