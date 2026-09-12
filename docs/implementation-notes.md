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

---

# M4 — Semantic document index

## Decisions

### Invalidation happens in the write that caused it

Marking derived artifacts stale is not a background job or a later pass; it is part of the same
transaction that changed the text. Nothing can leave the index claiming to be current when the
paragraph beneath it has moved on, because there is no window in which that state exists.

Regeneration is the opposite: always explicit, always asked for. Invalidate cheaply, recompute
lazily.

### Three freshness states, not two

`stale` means the text this describes has changed. `potentially_stale` means something below it
changed - a chapter brief whose section moved on is probably still broadly right. The distinction
is what stops one paragraph edit from invalidating an entire book's worth of summaries, and it is
the spec's own rule.

A block sitting directly under a chapter heading, with no subsection between, makes that chapter's
brief definitely stale rather than merely suspect. Where the two verdicts collide, the stronger one
wins.

### Summaries are built bottom-up

Sections summarise their paragraphs; chapters summarise their section briefs; the document
summarises its chapter briefs. A chapter brief is therefore a summary of summaries, which keeps the
cost of indexing a book proportional to its length rather than quadratic in it. Only stale levels
are rebuilt, and rebuilding runs bottom-up within a pass so a chapter is written from sections that
are already current.

The fast tier does all of it - this is compression, not judgement.

### Summaries are written for machines

The prompt asks for what the text *asserts*, in the author's own terminology, not what it covers.
"Defines high-risk systems as those listed in Annex III", never "discusses definitions". A brief
that paraphrases the author's terms makes the index worse than useless, because the whole point of
M5 is to notice when a term's meaning shifts.

### A stale brief is never sent

`briefsFor` hands the Context Builder only summaries the index calls current. A stale brief
describes text that no longer exists; feeding one to the model produces a confidently wrong answer
instead of a visibly incomplete one. When nothing current exists, the context digest says so.

This also closes the gap M2 declared: the digest no longer lists "summaries (built in M4)" as
withheld, because they are now sent when they exist.

### Hybrid retrieval by reciprocal rank

Lexical and vector search produce scores that are not comparable, so they are fused by rank rather
than by score: `1 / (k + rank)`, summed, with small bonuses for a block that contains the query
phrase verbatim and for one that *defines* a term in the query. RRF needs no normalisation between
rankers, degrades gracefully when one returns nothing, and has a single constant to tune rather
than a weight per signal.

Every hit reports which signals produced it, so a surprising ranking can be read rather than
guessed at.

### Extraction is local and free

Terms, definitions, claims and citations come from pattern rules, not a model. They run on every
indexed block at no token cost, and they are deliberately recall-oriented: over-producing is fine,
because precision is the reasoning model's job in M5. A definition is a far stronger retrieval
signal than similarity, and it costs nothing to have.

### The server layer exists to keep two rules true

`src/server/` is where the store and the AI gateway meet. Neither imports the other - `src/ai`
still cannot reach the store, and the editing path still cannot reach `src/ai`. Putting the indexer
inside `src/ai` would have been shorter and would have quietly broken both guarantees, which
`tests/architecture.test.ts` now checks at the `server/` boundary instead.

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| Separate Concept / Claim / Definition / Entity / Citation entities | One `semantic_units` table with a `unit_type` | The spec also asks for "a lightweight semantic model rather than a full formal knowledge graph". Five tables with identical shapes is the graph, not the lightweight version. Splitting later is a migration, not a redesign. |
| Embeddings for definitions, claims and decisions as semantic units | Blocks only | Block vectors carry the definitions and claims found inside them, and every retrieval path M5 needs works on blocks. Unit-level vectors are worth adding when something asks for them. |
| `pgvector` optional | Required by migration 0004 | A conditional schema would mean two retrieval implementations in PostgreSQL, and the spec is explicit that pgvector is sufficient and a separate vector database is not needed. |

## Known limitations

- **No vector index.** Exact search over `vector` without ivfflat or hnsw is linear in the number of
  blocks. Fine for a document; the index needs a fixed dimension, which means fixing the embedding
  model first.
- **Re-embedding is all-or-nothing per block.** A one-word fix re-embeds the paragraph. Cheap, but
  not free.
- **The document brief is regenerated whenever any chapter brief is**, since it is built from them.
  For a large manuscript that is the most expensive single artifact to keep current.
- **Extraction is English-only** and, being pattern-based, will over-produce proper nouns in
  heavily capitalised prose.
- **The file store's lexical search is term overlap**, not BM25, so ranking between two blocks that
  both match every term is arbitrary. PostgreSQL ranks properly.

---

# M5 — Impact analysis

## Decisions

### Search for what the change moved away from

The central move of candidate retrieval is not "find passages like the new text". It is: take the
terminology the change *removed*, and find everywhere in the document still saying it. A
terminology sweep is defined by what it leaves behind, and that is a lexical question with an exact
answer, not a similarity question with a fuzzy one.

Semantic similarity is still run, but it is the weakest arm. A passage that still uses the old term
is evidence; a passage that merely sounds alike is a guess, and the weights say so.

### Clustering before reasoning, not after

Fifty ledger entries from one sweep become one conceptual change before anything is retrieved or
reasoned about. Two rules do it, both local and free:

1. A focused vocabulary swap (at most three content words each way) clusters with every other
   change making the same swap, wherever in the document it happened.
2. Anything else clusters by block, so repeated work on one passage is one conceptual change.

Without this, a sweep would produce fifty retrievals and fifty reasoning calls to answer one
question, and the answers would disagree with each other.

### The reduction is the point, and it is reported

Everything before the model exists to shrink what the model sees. The analysis record stores
`blocksInDocument`, `candidatesConsidered` and the resulting `reductionPercent`, and the UI shows
it. The spec's target is over 80%; making the number visible is what stops retrieval from quietly
degrading into "send everything" as the ranking signals are tuned.

### Findings about passages that were never shown are dropped

The reply parser discards any finding citing a candidate number outside the range that was sent. A
model that invents a passage is hallucinating, and a fabricated finding costs the author more than
a missing one - it has to be read and dismissed before it can be ignored. Unknown enum values fall
back to the safest reading (`other`, `low`, `review`) rather than discarding an otherwise usable
finding.

### A failed analysis leaves its changes pending

If the model returns something unreadable, the analysis is recorded as `failed` with the reason,
and the ledger entries are deliberately *not* marked analysed. Marking them would hide them from
the next attempt, which is the one failure mode that would lose work silently.

### An empty result is a real result

If retrieval finds nothing, the analysis completes with a summary saying so and no reasoning call
is made at all. If the model finds nothing among the candidates, that is reported as a finding-free
briefing rather than padded. The prompt says this explicitly, because a briefing full of false
positives gets ignored, and an ignored briefing is worse than a short one.

### Impact analysis cannot edit the document

There is no method on the store's impact surface that writes content, and `src/server/impact.ts`
imports nothing that could. `generate_suggestion` is a *status* on a finding: it records that the
author wants it acted on. Producing the proposal is M6, and it will go through the same
suggestion workflow as every other AI edit - proposed, reviewed, accepted.

### Dismissals are kept

A resolved finding is updated, never deleted. The spec asks for dismissals to survive as review
history, and M7 will need them: a decision not to propagate a change is exactly the reasoning that
should stop the next analysis proposing it again.

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| `decision_rule_weight` in the candidate score | Not present | Decisions arrive in M7. The weight would be a constant multiplied by nothing. |
| Separate `POST /api/impact/:id/generate-suggestions` | Deferred to M6 | It is the propagation workflow, not the analysis. The status exists now so the intent can be recorded. |
| Impact analyses keyed under `/api/impact` | Under `/api/documents/:id/impact` | Everything else is already scoped by document; a second top-level namespace would be the only exception. |

## Known limitations

- **One reasoning call per analysis.** All clusters and all candidates go in together. That is
  cheaper and gives the model the cross-cluster view, but on a large analysis it means one long
  request, and attribution of a finding to a specific cluster is only exact when there is one.
- **Cross-reference detection matches heading titles textually.** "as discussed in Chapter 3" is
  found only when the changed material sits under a heading whose title appears in the referring
  text. Numbered references (§5.2) are not resolved to nodes.
- **No confidence threshold.** Everything the model returns is stored. Filtering by confidence is a
  UI decision that should be made after seeing real false-positive rates, not guessed at now.
- **Re-analysing re-examines resolved findings.** A dismissed finding does not yet suppress the same
  finding next time; that is what M7's decision memory is for.
- **The candidate list is capped.** It is 15% of the document's blocks, floored at 8 and ceilinged
  at 30, so the reduction target holds at any length. On a book with a pervasive term the ceiling is
  doing real work and the tail is invisible; the ranking decides which 30 survive, so its weights
  matter more than they look.
- **The semantic arm has no similarity floor.** It contributes its top 40 neighbours regardless of
  how weak the match is, and on a short document that is most of what fills the candidate pool
  before ranking. A threshold needs tuning against a real embedding model rather than guessing.
