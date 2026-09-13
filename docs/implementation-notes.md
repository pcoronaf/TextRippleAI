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

---

# M6 — Propagation workflow

## Decisions

### A propagated edit gets no shortcut

An edit the machine identified as necessary goes through exactly the same path as one the author
asked for: an inert proposal, reviewed as a diff, accepted explicitly, applied server-side with a
ledger entry. Being machine-identified is not evidence of being right - if anything it is the case
where a shortcut would do the most damage, because the author never formed the intent themselves.

`POST /impacts/:id/propose` therefore returns a suggestion, not a change.

### The proposal is measured against the passage as it stands now

The finding recorded the target text as it was when the analysis ran. The proposal records it as it
is when the draft is made. Acceptance checks the second, so an author who edited the passage in
between gets a stale-proposal refusal rather than having their work overwritten. The analysis being
out of date is a weaker condition than the passage being out of date, and it is the passage that
decides.

### The smallest edit, not the best paragraph

The propagation prompt extends the modify prompt with one instruction that matters: make the
closest version to the original that is no longer inconsistent, not the best version of the
paragraph. An author reviewing a propagated diff assumes everything in it was necessary; an
unrequested improvement smuggled into that diff is harder to catch than one offered on its own.

The prompt also explicitly permits returning the passage unchanged when the term is used in a
different sense - which is the false positive impact analysis is most likely to produce.

### `propagation` is a distinct source, not a flavour of `ai_accepted`

The ledger entry records which it is, and that single field is what the trace reads to know there
is a chain worth walking. Collapsing the two would have made "was this edit a consequence of
something else" a question you answer by joining three tables hopefully.

### Every hop in the trace is a stored link

    change.suggestionId -> suggestion.sourceImpactId -> impact.sourceChangeIds -> the original changes

Nothing is re-derived from the text, so the answer survives every later edit to any of the
paragraphs involved. `GET /changes/:id/trace` walks it in one request, and degrades to a short chain
for an ordinary manual change rather than erroring.

### A propagated change is itself pending

It is written with `impactStatus: 'pending'`, so the next analysis picks it up like any other
change. That is what the spec means by new changes becoming impact-analysis inputs: the ripple
continues until it stops producing consequences, rather than being cut off at one hop by
construction.

### Discussion reuses the conversation machinery

Discussing a finding opens an ordinary conversation anchored to the passage, with the finding's
explanation added as a context part and `related_impact_id` recorded on the conversation. No second
conversation system, and the discussion lives with the consequence rather than in a chat log.

## Known limitations

- **One proposal per finding at a time.** A second request is refused until the first is rejected.
  Revising a propagated proposal works through the ordinary revise path, which drops the impact
  link on the replacement - a gap worth closing when M7 gives revisions a reason to keep it.
- **The trace is one level deep in practice.** If a propagated change later causes its own finding,
  each hop is traceable individually but nothing renders the whole chain as one view.
- **Accepting several findings is one at a time**, each producing its own revision. A batch
  acceptance covering several findings in one revision would be a better review unit.
- **`discuss` scrolls to the passage to move the selection**, which is how the Ask panel learns
  which block is meant. It works, but it couples two panels through the editor selection rather
  than through state.

---

# M7 — Decision memory

## Decisions

### Suppression is deliberately narrow

A decision silences an impact finding only when it names the same passage *and* the same
vocabulary. The temptation is to let a decision silence a subject everywhere - and that is exactly
how a memory feature becomes a way to stop hearing about real problems.

A general preference ("prefer plain language") informs the model by travelling in the context. Only
a decision that explicitly names a passage suppresses anything, and even then a finding about
different vocabulary in that passage still gets through.

### Suppression happens before reasoning

A settled passage is dropped from the candidate list rather than filtered out of the findings. A
decision not to propagate is an answer; paying a model to re-derive it, then showing the author
something they already refused, is the failure this milestone exists to prevent. The briefing
reports how many candidates were suppressed, so the saving is visible rather than silent.

### Refusing is worth more than a status

"No change needed" now offers to record *why*. The status alone settles one finding; the reason
settles the question. This is the spec's own example - Chapter 8 discusses continuous monitoring, a
separate concept - and it is the difference between a system that forgets and one that does not.

Marking a finding settled without a reason is still available, and still one click.

### Scope, and why `from_node` earns its place

Three scopes: the whole document, one node and its section, or a node and everything after it.
The third is the spec's example and the one that actually matches how long documents work - a
terminology choice taken in Chapter 3 governs what follows without retroactively condemning
Chapter 1.

### Superseding happens in one write

Recording a decision that replaces another marks the old one superseded in the same transaction.
There is never a moment when both are in force, which matters because the conflict detector would
otherwise report the replacement as contradicting what it replaced.

### Conflicts are detected where a rule can be honest

Two shapes are found locally: one decision preferring X over Y while another prefers Y over X, and
two decisions replacing the same term with different words. Both are read from directional
preference phrasing ("use X rather than Y"), which is the form a terminology decision almost always
takes.

Semantic contradiction that is not phrased as a preference is out of reach of a regular expression,
and is not guessed at. Detection is advisory: it surfaces the pair and leaves the judgement to the
author.

### Nothing is ever deleted

Retiring and superseding change a status. The reasoning behind a choice stays readable after the
choice has moved on, which is the whole point of writing it down.

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| `scope: { type: 'from_node', node_id }` | Also `document` and `node` | `from_node` alone cannot express "this section only", which is the common case when a decision is about one passage rather than a direction of travel. |
| Conflict detection unspecified | Local detection of inverted and competing preferences | A model call per decision pair would cost more than the feature is worth at this size. The limitation is documented rather than hidden. |

## Known limitations

- **Conflict detection only reads preference phrasing.** Two decisions that contradict in substance
  but not in the form "use X rather than Y" are not detected.
- **Suppression matches on terms from the whole analysis**, not per finding: at the point candidates
  are filtered the impact type is not yet known, so a decision naming a type narrows the finding
  later rather than the candidate now.
- **Decisions are not themselves indexed or embedded.** Retrieval of applicable decisions is by
  scope, not by relevance, so a document with very many document-scoped decisions would send all of
  them and lean on the token budget to trim.
- **A decision cannot yet be created directly from a conversation turn.** The source exists and the
  API accepts it; the Ask panel has no button for it.

---

# M8 — Advanced document capabilities

M8 in the spec is a menu of "possible features", not an ordered checklist, and several of its
entries are listed among the initial non-goals. The subset built here is the one that closes debt
the earlier milestones incurred: things the change model already implied but the document model
could not yet carry.

Built: footnotes, images, comments, track-change marks, citation review.
Not built: real-time collaboration, desktop packaging, local model inference, PDF import, a plugin
ecosystem. Those are non-goals, not omissions — see the end of this section.

## Decisions

### A footnote is a block, not part of the paragraph's prose

The obvious implementation makes a footnote an inline node whose text is part of the paragraph. It
is wrong here, and expensively so. `nodeText()` feeds the diff, the content hash, the classifier,
the embedding and every summary. Folding a note into its paragraph means changing a citation in a
note rewrites the paragraph's hash, produces a change whose before/after are dominated by text the
author never touched, and poisons the paragraph's embedding with bibliographic noise.

So the model splits two operations that used to be one:

- `nodeText(node)` — what the paragraph *says*, with detached-text children (currently footnotes)
  excluded. This is what the change model, the index and the AI context all use.
- `ownText(node)` — everything under the node including notes. Used only where the literal
  serialisation matters.

A footnote carries its own persistent ID, appears in `flattenBlocks` as its own block, and so gets
its own ledger entries, its own embedding and its own place in impact analysis. Editing a note is a
tracked change against the note. A footnote can be the target of a finding — which is right: an
outdated citation in a note is exactly the kind of consequence this product exists to catch.

The cost is that `flattenBlocks` no longer returns blocks in a single containment order — a footnote
appears after the paragraph that carries it, though it lives inside it. Nothing downstream depends
on containment, only on order, so this is safe today and is written down because it will not be
obvious later.

### Word's footnotes arrive as a list at the end of the document

`mammoth` lowers footnotes to what HTML can express: a superscript link in the paragraph, and an
ordered list of definitions at the end of the body. Taken literally that produces a trailing list
of orphaned paragraphs with no relationship to the text that cites them.

`htmlToContent` therefore does a collection pass before walking the tree: it reads every
`<li id="footnote-N">` into a map, then converts each `<sup><a href="#footnote-N">` into a footnote
node holding that text, and suppresses the definition list itself. The suppression is narrow — a
list is only dropped when every item it holds was consumed as a footnote definition, so an ordinary
numbered list in a document that also has footnotes survives.

The map is module-scoped and cleared at the start of each `htmlToContent` call. `htmlToContent` is
synchronous and single-threaded, so this is safe; it is state that would not survive a move to a
streaming parser, and it is the one place in `src/formats` that is not a pure function of its
argument.

### Images keep their source; Word gets alt text

Before M8 an image survived import as alt text and nothing else, which silently destroyed content.
Images are now `image` nodes carrying `src`, `alt` and `title`, round-trip through HTML, Markdown
and canonical JSON, and render in the editor.

DOCX export still writes alt text. Embedding an image in a `.docx` means decoding the data URI,
sizing it, and managing relationship parts — real work whose absence is visible and recoverable (the
alt text says what was there) rather than silent. An image with no `src` is dropped rather than
emitted as an empty node, because an image node with nothing in it is worse than no node.

Images are inline data URIs in the document JSON. That is fine for diagrams and wrong for a
photograph-heavy manuscript; object storage is the eventual answer and is not here.

### Comments never reach a model

A comment is anchored to a block ID, has a body, a status and a resolver. It is stored beside the
document, not inside it: creating one does not change the content, does not bump the revision and
writes no ledger entry. A remark about the text is not a change to the text.

Comments are also deliberately excluded from the Context Builder. A reviewer's aside — "is this too
strong?" — is not authorial intent, and feeding it to a model would blur the line M7 drew between a
recorded decision and a passing remark. If a comment should bind the system's behaviour, the author
promotes it to a decision, which is an explicit act.

Resolving sets a status and a resolver; reopening clears the resolution rather than leaving a stale
`resolvedAt` behind. Nothing is deleted, consistent with everything else here.

### Track-change marks come from the ledger, not from a text diff

The visual "what changed since this checkpoint" could be computed by diffing the current content
against the checkpoint snapshot. It is not. The ledger already knows which blocks changed, why, and
how they were classified — a text diff would re-derive a worse version of that, disagree with the
change list in the sidebar whenever the two drifted, and lose the classification that lets
typographical noise be filtered out.

So the decoration plugin takes a set of block IDs from `GET /api/documents/:id/changes?since=…` and
marks those nodes. The marks survive editing because ProseMirror maps decorations through each
transaction rather than recomputing them. The consequence is that the granularity is the block: the
editor shows *that* a paragraph changed, not which words moved. Intra-paragraph insert/delete runs
in the Word sense are a larger piece of work and are not here.

### Citation review is a view over the index, not a new subsystem

M4 already extracts citations per block. M8 groups them by source, shows where each is used, and
flags those whose citing passage has changed since the review boundary — the same `since` that
drives the change list and the track-change marks. One review boundary, three views of it, which is
why comments, citations and the change marks share a single panel rather than three.

This is citation *review*, not citation *management*: there is no bibliographic database, no style
formatting, no DOI resolution. It answers "which of my sources are cited by text I have since
rewritten", which is the question this product is uniquely placed to answer.

## Deviations from the spec

| Spec | Here | Why |
|---|---|---|
| "Comment threads" | Single remarks with a status | Threading is a UI affordance over the same record; the anchoring and the resolve/reopen lifecycle are the parts the change model has to get right. Replies can be added without a schema change beyond a parent ID. |
| "Track changes visualisation" | Word-level insertion marks from the ledger | Deletions are not shown: the text is not in the document, and rendering it would mean displaying words the document does not contain. A block whose earlier text the ledger cannot supply is marked whole. |
| "Citation management" | Citation review | Managing citations is a bibliography product. Detecting that a cited passage drifted is the change-aware half, and the half nothing else does. |
| "Image support" | Inline in the document, alt text in DOCX | See above. |

## Known limitations

- **Footnote position is not preserved on DOCX export** beyond order: a note attaches to the end of
  the paragraph that carried it, not to the exact character offset of its reference.
- **Images do not survive a DOCX round trip.** Import keeps them; export writes alt text.
- **Comments are not anchored to a range**, only to a block. A remark about one sentence in a long
  paragraph is shown against the whole paragraph.
- **A comment's anchor can be orphaned.** If the block it points at is deleted, the comment remains
  and lists as anchored to a block that is no longer in the document. It is kept rather than
  removed, consistent with the rest of the system, but nothing yet surfaces that state.
- **Track-change marks show insertions, not deletions.** Removed text is not in the document, so
  marking it would mean rendering words that are not there; a deletion shows in the change list
  only. A block deleted outright likewise has nothing left to decorate.
- **The marks compare against the review boundary, not the last edit.** A paragraph edited five
  times since a checkpoint is marked with its net difference from the checkpoint, which is the
  question the boundary is asking.
- **Citation grouping is by normalised text**, so "ISO/IEC 42001:2023" and "ISO 42001" are two
  sources. Identity resolution needs a bibliographic database, which is a non-goal.

## Deliberately not built

These are spec items that were considered and rejected for this milestone, most because the spec
itself lists them as initial non-goals:

- **Real-time collaboration (Yjs/CRDT).** It is not an additional feature; it changes the
  concurrency model the whole store rests on. Optimistic concurrency with `expectedRevision` and a
  CRDT are two different products, and the change ledger's "who changed what, when, in which
  session" is the harder question under multiplayer.
- **Desktop packaging**, **local model inference**, **PDF import/OCR**, and a **plugin ecosystem**.
  All listed as non-goals; none of them exercise the change model, which is what these milestones
  exist to prove.

---

# Packaging — one Windows executable, no dependencies

Not a milestone from the spec; the spec lists desktop packaging among the initial non-goals, and
this is not that. It is the same web app, served locally by a binary that carries its own runtime,
so that someone without Node can run it. Nothing about the architecture changes: the same Next.js
server, the same store boundary, the same file store.

## Decisions

### A Node Single Executable Application, not an installer or a desktop shell

Three ways to ship this were on the table.

A **portable folder** (the standalone server plus a Node runtime, zipped) is the least work and the
least useful: the user unzips eleven thousand files and hunts for the thing to double-click.

**Tauri or Electron** gives a real desktop window, and costs a Rust or Chromium toolchain in CI, an
installer, an update channel, and a second process model to reason about — for a product whose
interface is a document in a browser. The spec calls desktop packaging a non-goal, and it is right.

A **Node SEA** puts the Node runtime and the whole built app into one file. The runtime is already
a dependency; this just stops asking the user to install it separately. No installer, no registry,
no toolchain beyond what CI already has.

The cost is size — the Node runtime dominates — and that SEA is still a young feature. Both are
acceptable for a binary that is rebuilt by CI on every push.

### The app is carried as a zip and unpacked on first run

A SEA embeds *assets*, but Next's standalone server expects to read its own file tree from disk:
`.next/`, `required-server-files.json`, a `node_modules` it resolves normally. Faking that inside
the binary would mean intercepting module resolution and filesystem reads — a lot of machinery to
avoid writing files that have to exist anyway.

So the archive is extracted once to `%LOCALAPPDATA%\TextRippleAI\app-<build id>` and the server is
loaded from there with a `require` rooted in that directory. The build id is the hash of the
archive, so a new build unpacks beside the old one rather than over it, and extraction is atomic:
it goes to a staging directory and is renamed into place, so an interrupted first run leaves
nothing that a later run could mistake for a good installation.

### The zip reader is written by hand

A SEA entry point must be a single file with no dependencies. Node ships `zlib` but no zip reader,
so `desktop/launcher.js` contains one — about 120 lines for the central directory, the local
headers, and stored/deflated entries.

Two things it does that a convenience library would not necessarily do:

- **Every entry's CRC is checked.** The archive arrives inside a downloaded binary. A truncated
  download should fail while unpacking, with a clear message, rather than three seconds later as an
  incomprehensible error from inside the server.
- **Entry paths are refused if they escape the destination.** We build the archive ourselves, so
  today it cannot contain `../`. But a zip reader that trusts its input is exactly how a packaged
  app writes files it was never meant to, and the guard costs four lines.

### The build verifies the archive before it ships it

`scripts/build-exe.mjs` extracts the archive it has just written, using the launcher's own reader,
and compares the result against the source tree file by file and hash by hash. A packaging bug then
fails on the build machine rather than on a desktop.

The writer and the reader deliberately share the CRC implementation — that part is not
independently verified — but the file list, the lengths and the content hashes are, and the
round-trip is also exercised directly by unit tests with an empty file, a binary file, a unicode
filename, a deliberately corrupted payload and a path-traversal attempt.

### CI starts the executable

The strongest thing here: the Windows job runs the binary it just built with `--smoke`, which
unpacks it, starts the server inside it, and checks that `/api/ai/status`, `/api/documents` and `/`
all answer. A build that packages wrong, unpacks wrong or fails to boot fails in CI.

This matters because there is no Node, npm or Docker on the development machine — CI is the only
place anything here can actually run. Without the smoke run the first person to execute the binary
would be whoever downloaded it.

### Documents live in %LOCALAPPDATA%, not beside the executable

The file store already read `DATA_DIR`, so the launcher just sets it. Writing next to the exe would
break the moment someone ran it from `Program Files`, a read-only share or a Downloads folder
synced by something. It also means deleting the exe does not delete the documents, and that two
different builds share one document set.

### It binds loopback, and a second launch joins the first

`127.0.0.1` only: this is a local application, and an editor that silently served the user's
manuscript to the network would be a poor default.

It tries port 3717 first. If something is already there and answers like this app, the launcher
reopens that browser tab and exits rather than starting a second server over the same documents —
the file store is not built for two writers. If the port is taken by something else, it picks a
free one.

## Known limitations

- **The executable is unsigned**, so SmartScreen warns on first launch. Signing needs a
  certificate, which is an organisational matter rather than a technical one.
- **Windows x64 only.** Nothing in the approach is Windows-specific and the build script runs
  elsewhere, but only that target is built and smoke-tested.
- **Roughly 100 MB**, most of it the Node runtime.
- **No auto-update.** A new build is a new download, and it unpacks beside the old one; the old
  `app-<id>` directories are never cleaned up.
- **First launch is slow** — the archive has to be unpacked before the server starts.
- **Closing the console window stops the app.** There is no tray icon and no service.
- **The DOCX and PDF paths are unchanged**, as is everything else: this packages the app, it does
  not alter it.
