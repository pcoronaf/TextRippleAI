# Change-Aware AI Document Editor
## Architecture, Design Specification, and Development Plan

**Version:** 0.1  
**Status:** Initial design specification  
**Purpose:** Define the architecture and development plan for an AI-assisted document editor that supports selective conversational editing, explicit change tracking, and downstream impact analysis across long documents.

---

# Product Vision

The product is a document editor with an explicit AI reasoning layer.

The document remains the authoritative artifact. The AI does not continuously monitor or rewrite the document. Instead, it is invoked only when the user explicitly requests assistance, for example by selecting a paragraph and asking a question, requesting a modification, or launching an analysis of accumulated changes.

The core workflow is:

> **Write → Select → Ask or Change → Review → Continue Writing → Analyze Accumulated Changes → Identify Downstream Impacts → Approve Proposed Corrections**

The tool is intended primarily for long-form and structured documents such as:

- books;
- theses and dissertations;
- scientific papers;
- standards;
- technical specifications;
- policies;
- regulations;
- legal or governance documents;
- reports;
- manuals;
- documentation sets.

The product is not merely “chat with a document.” Its differentiating capability is that it maintains structured knowledge about **what changed, why it changed, and where that change may have consequences elsewhere**.

---

# Design Principles

## The document is authoritative

The editor contains the current authoritative version of the document.

AI-generated text is never silently inserted into the document. AI output is first represented as a proposal or suggestion. The user explicitly accepts or rejects it.

---

## Editing and AI reasoning are separate

Normal typing must not cause an LLM request.

The editor captures edits locally and records them in structured form. LLM calls happen only when:

- the user asks a question about selected text;
- the user requests a rewrite or modification;
- the user asks for consistency analysis;
- the user requests impact analysis;
- the system must refresh a semantic artifact needed to answer a user request.

This is essential for predictable cost and token efficiency.

---

## Invalidate cheaply; recompute lazily

When a paragraph changes, dependent summaries, embeddings, or semantic indexes are marked as stale.

They are not immediately regenerated.

They are refreshed only when:

- required by a query;
- included in an explicit impact-analysis request;
- processed during a checkpoint;
- processed by a scheduled background task in a future version.

---

## Stable identity is more important than text position

Paragraphs and document elements must retain persistent identifiers.

Text offsets such as “characters 4,521–4,878” are unsuitable because they become invalid after edits.

The canonical model should therefore use persistent IDs such as:

```text
document UUID
chapter UUID
section UUID
paragraph UUID
table UUID
figure UUID
```

---

## Changes, decisions, and impacts are distinct entities

The product must explicitly distinguish:

### Change

What changed in the document.

### Decision

Why the change was made, or what rule should guide future editing.

### Impact

What other parts of the document may be affected by that change or decision.

Example:

```text
CHANGE
"cybersecurity incident probability"
→
"likelihood of a cybersecurity incident"

DECISION
Use "likelihood" instead of "probability" unless a mathematically
defined probability is intended.

IMPACT
17 other occurrences identified.
6 probably require modification.
11 appear to use probability in the strict mathematical sense and
should remain unchanged.
```

This distinction is one of the core conceptual elements of the product.

---

# High-Level Architecture

```text
                         ┌──────────────────────┐
                         │        User          │
                         └──────────┬───────────┘
                                    │
                ┌───────────────────▼──────────────────┐
                │          Document Editor             │
                │                                      │
                │  Word-like editing       AI sidebar  │
                │  comments                Ask/Modify  │
                │  change tracking         Impact view │
                └────────┬──────────────┬──────────────┘
                         │              │
              every edit │              │ explicit AI request
                         ▼              ▼
                ┌────────────────┐   ┌─────────────────────┐
                │ Change Capture │   │ AI Orchestrator     │
                │                │   │                     │
                │ NO LLM CALL    │   │ Context builder     │
                └───────┬────────┘   │ Retrieval           │
                        │            │ Prompt construction │
                        ▼            │ Model routing       │
                ┌────────────────┐   └─────────┬───────────┘
                │ Change Ledger  │             │
                └───────┬────────┘             ▼
                        │              ┌──────────────────┐
                        │              │ LLM provider(s)  │
                        │              └──────────────────┘
                        │
                        ▼
          ┌─────────────────────────────┐
          │ Document Intelligence       │
          │                             │
          │ structure / summaries       │
          │ concepts / entities         │
          │ semantic vectors            │
          │ cross-references            │
          │ claims / definitions        │
          └─────────────────────────────┘
```

---

# Proposed Technology Stack

| Layer | Recommendation |
|---|---|
| Front end | React + Next.js |
| Editor | Tiptap over ProseMirror |
| Client-side persistence | IndexedDB / local cache |
| API | TypeScript + Node.js |
| Database | PostgreSQL |
| Vector search | pgvector |
| Full-text search | PostgreSQL full-text search |
| Background jobs | Lightweight queue/worker architecture |
| File/object storage | S3-compatible object storage |
| Authentication | OIDC-compatible identity provider |
| AI integration | Provider-independent AI gateway |
| Desktop packaging | Tauri in a later phase |
| Collaboration | Yjs in a later phase if required |

The core document and change model should remain independent of the editor UI, AI provider, and deployment environment.

---

# Editor Architecture

Tiptap over ProseMirror is recommended because ProseMirror represents editing operations as structured transactions instead of treating the document as a simple HTML string.

This provides an appropriate foundation for:

- persistent node identity;
- structured document editing;
- custom metadata;
- change tracking;
- suggestions;
- annotations;
- selection-aware AI operations;
- future collaborative editing.

The editor should use a structured JSON document representation internally.

Example:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": {
        "id": "sec_901",
        "level": 1
      },
      "content": [
        {
          "type": "text",
          "text": "Introduction"
        }
      ]
    },
    {
      "type": "paragraph",
      "attrs": {
        "id": "p_78f24"
      },
      "content": [
        {
          "type": "text",
          "text": "Example paragraph."
        }
      ]
    }
  ]
}
```

---

# Persistent Document Nodes

Every meaningful document element receives a UUID or equivalent persistent identifier.

Initial supported node types should include:

```text
Document
Chapter
Section
Heading
Paragraph
List
List Item
Table
Table Row
Table Cell
Figure
Caption
Footnote
Citation
Quote
Code Block
```

A canonical node record may look like:

```json
{
  "id": "p_78f24",
  "document_id": "doc_17",
  "parent_id": "sec_4b23",
  "type": "paragraph",
  "revision": 27,
  "content_hash": "sha256:...",
  "position_hint": 43,
  "created_at": "...",
  "updated_at": "..."
}
```

`position_hint` is useful for ordering but must not be treated as the permanent identity.

---

# Change Capture

Every editor transaction is observable, but not every keystroke becomes a meaningful change record.

The client captures low-level edit transactions and feeds them into a **Change Aggregator**.

The aggregator groups operations according to rules such as:

```text
same document node
+ same author
+ same editing session
+ short interval
+ same operation family
```

Example:

Typing:

```text
cybersecurity
```

must not generate 13 meaningful changes.

It should eventually generate one record such as:

```text
Change #487
Block: p_91

Before:
"cyber security"

After:
"cybersecurity"
```

---

# Change Ledger

The Change Ledger is an append-oriented record of meaningful document changes.

It is separate from normal undo/redo history.

Example schema:

```json
{
  "change_id": "chg_9132",
  "document_id": "doc_17",
  "block_id": "p_78f24",
  "author_id": "usr_12",
  "source": "human",
  "operation": "replace",
  "before": "Artificial intelligence systems always require human supervision.",
  "after": "High-risk artificial intelligence systems should normally remain subject to meaningful human oversight.",
  "created_at": "...",
  "checkpoint_id": null,
  "impact_status": "pending"
}
```

For an AI-assisted modification:

```json
{
  "change_id": "chg_9133",
  "document_id": "doc_17",
  "block_id": "p_78f24",
  "source": "ai_accepted",
  "prompt": "Make this assertion less absolute.",
  "model": "provider:model",
  "suggestion_id": "sug_77",
  "accepted_by": "usr_12",
  "created_at": "...",
  "impact_status": "pending"
}
```

---

# AI Suggestions

AI proposals and accepted document edits must remain separate.

Suggested state machine:

```text
GENERATED
   │
   ├──> REJECTED
   │
   ├──> DISCUSSED
   │       │
   │       └──> REVISED
   │
   └──> ACCEPTED
            │
            └──> DOCUMENT CHANGE
```

A suggestion record may contain:

```json
{
  "suggestion_id": "sug_77",
  "document_id": "doc_17",
  "block_id": "p_78f24",
  "selection_start": 0,
  "selection_end": 120,
  "before": "...",
  "proposed": "...",
  "prompt": "...",
  "status": "generated",
  "created_at": "..."
}
```

The authoritative document changes only after `ACCEPTED`.

---

# Initial AI Interaction

The first release should support selection-based AI interaction.

When the user selects text, a contextual control appears:

```text
Ask AI | Modify | Explain | Check consistency
```

The AI sidebar shows:

```text
SELECTED TEXT

"Zero Trust assumes that no user, device or application
should automatically be trusted based on network location."

────────────────────────────────

Ask about this text...

> Is "automatically" necessary here?
```

---

# Context Builder

The model should receive the smallest context sufficient to answer the request.

For a paragraph-level question, the context may contain:

```text
Document brief
Section title
Section brief
Previous paragraph
Selected paragraph
Next paragraph
Relevant accepted decisions
User request
```

The entire document should not be sent unless explicitly required.

A context package might therefore be:

```json
{
  "document_brief": "...",
  "section": {
    "title": "...",
    "summary": "..."
  },
  "previous_block": "...",
  "selected_block": "...",
  "next_block": "...",
  "relevant_decisions": [],
  "request": "Is 'automatically' necessary here?"
}
```

---

# AI Modification Workflow

Example request:

> Rewrite this paragraph so that it does not imply that Zero Trust means nothing is ever trusted.

AI response:

```text
Proposed replacement
────────────────────

Zero Trust avoids granting implicit trust to users,
devices or applications solely because of their network
location; access decisions instead depend on continuously
evaluated identity, context and policy.

[Accept] [Reject] [Discuss]
```

Accepting the suggestion creates:

1. a document revision;
2. a Change Ledger entry;
3. provenance linking the edit to the AI prompt;
4. a pending impact-analysis marker.

---

# Manual Changes

Manual editing must have the same analytical importance as AI-assisted editing.

If the user directly rewrites a paragraph:

```text
old hash → new hash
```

the system records the before/after content and marks:

```text
impact_status = pending
embedding_status = stale
summary_status = potentially_stale
```

No LLM call occurs.

---

# Checkpoints

A checkpoint defines a meaningful review boundary.

Examples:

```text
Imported manuscript
Methodology approved
End of editing session
Supervisor review 2026-09-12
Pre-publication review
```

A checkpoint record:

```json
{
  "checkpoint_id": "cp_22",
  "document_id": "doc_17",
  "name": "Methodology approved",
  "created_at": "...",
  "created_by": "usr_12",
  "document_revision": 448
}
```

The UI can report:

```text
Changes since last review: 37

Chapter 2      8
Chapter 3     21
Chapter 4      8

[Analyze impact]
```

---

# Impact Analysis

Impact analysis is an explicit user action.

The system should support requests such as:

> Analyze all changes since the Methodology approved checkpoint.

> Analyze today's changes and determine whether Chapters 5–8 should change.

> Check whether changes to terminology in Chapter 2 affect the conclusions.

---

# Impact Analysis Pipeline

```text
Pending changes
      │
      ▼
Normalize changes
      │
      ▼
Filter trivial/editorial changes
      │
      ▼
Cluster related changes
      │
      ▼
Extract concepts / claims / definitions
      │
      ▼
Retrieve potentially affected nodes
      │
      ▼
Rank candidates
      │
      ▼
LLM reasoning
      │
      ▼
Impact briefing
```

The model should reason over retrieved candidates rather than scan the entire document.

---

# Change Classification

Changes can initially be classified into categories such as:

```text
typographical
editorial
style
terminology
definition
factual assertion
numerical value
citation
methodology
scope
requirement
conclusion
cross-reference
structural
```

Purely typographical changes can normally be excluded from deeper impact analysis.

---

# Candidate Impact Retrieval

Candidate retrieval should combine multiple signals.

| Signal | Example |
|---|---|
| Exact terminology | “human supervision” occurs elsewhere |
| Definitions | Definition of “high-risk system” changed |
| Named entities | ISO/IEC 42001 occurs in other sections |
| Cross-references | “as discussed in Chapter 3” |
| Citations | Same source supports another claim |
| Semantic similarity | Different wording, same underlying concept |
| Structural relationship | Conclusion summarizes an earlier chapter |
| Claim dependency | Later claim relies on modified premise |
| Numeric dependency | 35% appears in a result and conclusion |
| Acronym dependency | Definition of AGI changes later interpretation |

A candidate score can combine these signals:

```text
candidate_score =
    lexical_similarity
  + semantic_similarity
  + explicit_reference_weight
  + shared_entity_weight
  + shared_citation_weight
  + structural_dependency_weight
  + decision_rule_weight
```

Exact weighting can be tuned empirically.

---

# Document Intelligence Index

The first version should use a lightweight semantic model rather than a full formal knowledge graph.

Conceptually:

```text
Document
 ├── Chapter
 │    ├── Section
 │    │    ├── Paragraph
 │    │    ├── Claim
 │    │    ├── Definition
 │    │    ├── Citation
 │    │    └── Entity
 │    └── Summary
 └── Document Summary
```

Possible relationship types:

```text
DEFINES
USES_TERM
REFERENCES
SUPPORTS
CONTRADICTS
SUMMARIZES
DEPENDS_ON
REFERS_TO
CITES
DERIVES_FROM
```

---

# Hierarchical Document Memory

The system should maintain hierarchical summaries:

```text
Document brief
    ↓
Chapter brief
    ↓
Section brief
    ↓
Actual paragraphs
```

Typical context sizes might be:

```text
Document brief     ~1,000 tokens
Chapter brief        ~400 tokens
Section brief        ~150 tokens
Selected text        ~100–500 tokens
Neighboring text     ~200–800 tokens
```

This allows the AI to reason about document-level context without receiving the entire manuscript.

---

# Summary Invalidation

When a paragraph changes:

```text
paragraph = current
section summary = stale
chapter summary = potentially stale
document summary = potentially stale
```

The summaries are regenerated only when required.

This follows the design rule:

> **Invalidate cheaply; recompute lazily.**

---

# Embeddings and Semantic Retrieval

Embeddings should be generated at the block or semantic-unit level.

Recommended semantic units include:

- paragraphs;
- definitions;
- claims;
- section summaries;
- decisions.

When text changes:

```text
embedding_status = stale
```

Embeddings should be refreshed:

- before semantic impact analysis;
- when required by a user query;
- in batch at a checkpoint;
- by a future background optimizer.

PostgreSQL with pgvector is sufficient for the initial product.

A separate vector database is not required for the first versions.

---

# Hybrid Retrieval

Semantic similarity alone is not enough.

Candidate retrieval should combine:

```text
PostgreSQL full-text search
+
pgvector semantic search
+
explicit document relationships
+
change/decision metadata
```

This improves recall for exact terminology while preserving semantic matching.

---

# Decisions

A decision represents persistent authorial intent.

Example:

```json
{
  "decision_id": "dec_17",
  "document_id": "doc_17",
  "title": "Prefer human oversight terminology",
  "description": "Use 'human oversight' rather than 'human supervision' when discussing governance requirements.",
  "scope": {
    "type": "from_node",
    "node_id": "chapter_3"
  },
  "status": "accepted",
  "source": "impact_review",
  "created_at": "..."
}
```

Decisions prevent important reasoning from disappearing inside chat history.

---

# Decision Example

The AI identifies an impact:

> Chapter 8 should also use “human oversight.”

The user responds:

> No. Chapter 8 intentionally discusses continuous monitoring rather than human oversight.

The system offers to record:

```text
DECISION D42

Do not propagate the Chapter 3 terminology change to Chapter 8.

Reason:
Chapter 8 addresses continuous monitoring as a separate concept.

Status:
Accepted
```

Future impact analysis includes this decision automatically when relevant.

---

# Conversation Architecture

The system should not use a single ever-growing LLM conversation as the document's memory.

Instead, conversations are application objects.

Example:

```json
{
  "conversation_id": "conv_88",
  "document_id": "doc_17",
  "anchor_block_id": "p_78f24",
  "selection": {
    "from": 12,
    "to": 130
  },
  "related_change_id": null,
  "created_at": "..."
}
```

A conversation may be anchored to:

- a document;
- a chapter;
- a section;
- a paragraph;
- a selection;
- a change;
- an impact-analysis result.

The application reconstructs context server-side.

---

# AI Gateway

The product should be provider-independent.

```text
                   AI Gateway
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
   fast/cheap       reasoning        embedding
     model            model            model
```

Possible functions:

### Fast or inexpensive model

- change classification;
- query expansion;
- simple editing;
- grammar;
- short summaries;
- metadata extraction.

### Reasoning model

- contradiction analysis;
- cross-chapter impact analysis;
- methodological consequences;
- complex rewriting;
- argument consistency;
- dependency reasoning.

### Embedding model

- semantic indexing;
- candidate retrieval;
- clustering support.

Local models may later perform some inexpensive or privacy-sensitive tasks.

---

# Token Economy

Token economy is a core architectural requirement.

## No LLM requests during normal typing

Normal editing consumes zero LLM tokens.

---

## Send only selected and relevant context

A paragraph question should not transmit the full document.

---

## Store diffs rather than repeatedly analyzing complete documents

Impact analysis begins with changed material.

---

## Cluster changes

Fifty small edits may represent only three conceptual changes.

The LLM should reason over the conceptual clusters where possible.

---

## Hierarchical summaries

Use document/chapter/section summaries instead of full document text.

---

## Lazy embeddings

Regenerate only stale embeddings that are needed.

---

## Persistent decisions

Do not resend entire old conversations just to remind the model of prior author decisions.

---

## Model routing

Use expensive reasoning models only when needed.

---

## Cache context fragments

Stable summaries, metadata, and prompt components should be cacheable.

---

# Impact Briefing

Impact analysis should produce a structured briefing before any downstream modification.

Example:

```text
Impact analysis — 23 pending changes

MAJOR CONCEPTUAL CHANGE

Chapter 3 now distinguishes human oversight from continuous
human supervision.

Potentially affected:

§5.2   Uses previous stronger interpretation       HIGH
§6.4   Definition is inconsistent                  HIGH
§8.1   Conclusion assumes continuous supervision   MEDIUM
§9.3   No substantive conflict                     LOW

Suggested action:

- Revise §5.2
- Revise §6.4
- Review §8.1 manually
- No change recommended for §9.3
```

Actions:

```text
[Review suggestions]
[Discuss analysis]
[Generate proposed changes]
[Mark as reviewed]
```

No automatic downstream modification occurs.

---

# Impact Entity

Suggested structure:

```json
{
  "impact_id": "imp_91",
  "source_change_ids": [
    "chg_9132",
    "chg_9133"
  ],
  "target_block_id": "p_991",
  "impact_type": "terminology_consistency",
  "confidence": 0.91,
  "severity": "high",
  "explanation": "...",
  "recommended_action": "revise",
  "status": "pending"
}
```

Suggested status machine:

```text
PENDING
  │
  ├──> DISMISSED
  │
  ├──> ACCEPTED_NO_CHANGE
  │
  ├──> NEEDS_REVIEW
  │
  └──> GENERATE_SUGGESTION
             │
             ├──> REJECTED
             └──> ACCEPTED
```

---

# Canonical Data Model

Initial principal entities:

```text
User
Workspace
Document
DocumentNode
DocumentVersion
Change
Checkpoint
Suggestion
Decision
Conversation
Message
Summary
Embedding
Concept
Claim
Definition
Entity
Citation
Relationship
ImpactAnalysis
Impact
```

---

# Suggested Relational Schema

## documents

```text
id
workspace_id
title
current_revision
status
created_at
updated_at
```

## document_nodes

```text
id
document_id
parent_id
type
position
revision
content
content_hash
created_at
updated_at
```

## document_versions

```text
id
document_id
revision
snapshot_location
created_at
created_by
```

## changes

```text
id
document_id
block_id
author_id
source
operation
before_content
after_content
prompt
model
suggestion_id
checkpoint_id
impact_status
created_at
```

## suggestions

```text
id
document_id
block_id
conversation_id
prompt
before_content
proposed_content
status
model
created_at
resolved_at
```

## decisions

```text
id
document_id
title
description
scope
status
source
created_at
updated_at
```

## checkpoints

```text
id
document_id
name
revision
created_by
created_at
```

## summaries

```text
id
document_id
node_id
summary_type
content
source_revision
status
model
created_at
updated_at
```

## embeddings

```text
id
document_id
node_id
embedding_type
vector
source_revision
status
created_at
updated_at
```

## relationships

```text
id
document_id
source_id
target_id
relationship_type
confidence
source
created_at
```

## conversations

```text
id
document_id
anchor_node_id
related_change_id
related_impact_id
created_at
updated_at
```

## messages

```text
id
conversation_id
role
content
model
token_usage
created_at
```

## impact_analyses

```text
id
document_id
base_checkpoint_id
target_revision
status
summary
created_at
completed_at
```

## impacts

```text
id
impact_analysis_id
target_node_id
impact_type
confidence
severity
explanation
recommended_action
status
```

---

# API Boundaries

Example API organization:

```text
/api/documents
/api/documents/:id/nodes
/api/documents/:id/changes
/api/documents/:id/checkpoints
/api/documents/:id/summaries
/api/documents/:id/decisions
/api/documents/:id/search

/api/ai/ask
/api/ai/modify
/api/ai/explain
/api/ai/check-consistency

/api/impact/analyze
/api/impact/:id
/api/impact/:id/generate-suggestions
```

---

# Example AI Ask Request

```json
{
  "document_id": "doc_17",
  "selection": {
    "block_id": "p_78f24",
    "from": 21,
    "to": 159
  },
  "question": "Is this statement too absolute?"
}
```

The client should not decide the full AI context.

The server-side Context Builder determines:

- relevant summaries;
- adjacent blocks;
- applicable decisions;
- related definitions;
- token budget;
- model.

---

# Example AI Modify Request

```json
{
  "document_id": "doc_17",
  "selection": {
    "block_id": "p_78f24",
    "from": 0,
    "to": 215
  },
  "instruction": "Rewrite this so that it does not imply Zero Trust means nothing is ever trusted."
}
```

Response:

```json
{
  "suggestion_id": "sug_77",
  "before": "...",
  "proposed": "...",
  "rationale": "...",
  "status": "generated"
}
```

---

# Example Impact Analysis Request

```json
{
  "document_id": "doc_17",
  "from_checkpoint_id": "cp_22",
  "scope": {
    "type": "following_chapters"
  },
  "instructions": "Identify conceptual, terminology, factual, methodological and conclusion-level consequences."
}
```

---

# Document Import and Export

## Initial formats

M0 should prioritize:

```text
DOCX import
DOCX export
plain text
Markdown
```

PDF should initially be treated as an import/reference format rather than the canonical editable source.

The internal canonical representation remains structured JSON.

---

# DOCX Fidelity Strategy

Full Microsoft Word fidelity is difficult and should not block the first release.

Initial goal:

- headings;
- paragraphs;
- bold/italic;
- numbered and bulleted lists;
- tables;
- hyperlinks;
- footnotes where practical;
- basic citations;
- images;
- comments if feasible.

Advanced layout fidelity can be addressed after the core change-intelligence workflow is proven.

---

# Security and Privacy

The architecture should allow the user to understand exactly what text is sent to an external model.

Recommended controls:

```text
External AI enabled / disabled
Local-only document
Provider selection
Model selection
Do not send full document
Show AI context
Redact selected entities
```

A future enterprise version should support:

- self-hosted models;
- private model endpoints;
- tenant-level policy;
- encryption;
- audit logs;
- retention configuration;
- regional processing restrictions.

---

# User Interface

Initial desktop/web layout:

```text
┌────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Insert  AI  Review                              │
├──────────────┬─────────────────────────────────┬───────────────────┤
│              │                                 │                   │
│ Document     │          EDITOR                 │ AI / Review       │
│ Outline      │                                 │ Sidebar           │
│              │                                 │                   │
│ Chapter 1    │                                 │ Ask               │
│ Chapter 2    │                                 │ Changes           │
│ Chapter 3    │                                 │ Impacts           │
│              │                                 │ Decisions         │
│              │                                 │                   │
├──────────────┴─────────────────────────────────┴───────────────────┤
│ 37 pending changes | 4 stale summaries | Last checkpoint: CP22   │
└────────────────────────────────────────────────────────────────────┘
```

---

# Sidebar Modes

The right-hand sidebar should initially support:

```text
ASK
CHANGE
IMPACT
DECISIONS
```

Later:

```text
COMMENTS
CITATIONS
DOCUMENT MAP
CLAIMS
CONCEPTS
```

---

# Development Plan

## M0 — Document Core

### Objective

Build a reliable editable document model.

### Features

- Next.js application shell;
- Tiptap editor;
- persistent node IDs;
- document JSON persistence;
- create/open/save documents;
- heading and paragraph structure;
- basic lists;
- basic tables;
- DOCX import baseline;
- DOCX export baseline;
- local autosave;
- document revisions.

### Acceptance Criteria

- Paragraph IDs survive normal edits.
- Adding paragraphs does not renumber existing IDs.
- Closing and reopening the document preserves structure.
- Document JSON can be round-tripped reliably.
- A basic DOCX can be imported and exported.

---

# M1 — Change Intelligence

### Objective

Capture and manage meaningful human changes.

### Features

- transaction observation;
- Change Aggregator;
- before/after diffs;
- Change Ledger;
- change source tracking;
- pending change count;
- checkpoints;
- comparison since checkpoint;
- change review interface.

### Acceptance Criteria

- Typing a word creates one meaningful change, not one per keystroke.
- Manual paragraph rewrites are captured with before/after values.
- The user can create a named checkpoint.
- The system can list all changes since a checkpoint.
- Normal editing requires no LLM request.

---

# M2 — Chat With Selection

### Objective

Allow explicit contextual questions about document text.

### Features

- text selection;
- floating AI toolbar;
- Ask AI action;
- AI sidebar;
- server-side Context Builder;
- neighboring-paragraph context;
- section summary context;
- conversation persistence;
- model/provider abstraction;
- token logging.

### Acceptance Criteria

- User can select text and ask a question.
- Only relevant context is sent to the AI.
- Responses remain anchored to the selected text.
- A follow-up question remains in the same local conversation.
- Normal typing still produces no LLM traffic.

---

# M3 — AI Editing

### Objective

Allow controlled AI modifications.

### Features

- Modify action;
- proposed replacement;
- diff visualization;
- accept;
- reject;
- discuss;
- revise suggestion;
- AI provenance;
- accepted AI change written to Change Ledger.

### Acceptance Criteria

- AI cannot silently modify authoritative text.
- User sees before/after content.
- Accepted suggestions become document changes.
- Rejected suggestions leave the document unchanged.
- Provenance records prompt, provider, model, and related suggestion.

---

# M4 — Semantic Document Index

### Objective

Build efficient document-level retrieval.

### Features

- section summaries;
- chapter summaries;
- document summary;
- stale-summary tracking;
- PostgreSQL full-text search;
- pgvector;
- block embeddings;
- semantic search;
- terminology/entity extraction;
- simple definition detection;
- simple claim detection.

### Acceptance Criteria

- Changed paragraphs mark their embeddings stale.
- Stale embeddings can be regenerated in batch.
- Semantic search returns related paragraphs.
- Exact terminology search and vector retrieval can be combined.
- Section summaries regenerate only when needed.

---

# M5 — Impact Analysis

### Objective

Analyze accumulated changes and identify downstream consequences.

### Features

- Analyze Changes action;
- scope selection;
- change classification;
- trivial-change filtering;
- change clustering;
- candidate retrieval;
- ranked affected sections;
- reasoning model analysis;
- impact briefing;
- confidence;
- severity;
- recommended action.

### Acceptance Criteria

- User can analyze changes since a checkpoint.
- Typographical changes can be ignored automatically.
- Potentially affected later sections are identified.
- Results explain why each target may be affected.
- Impact analysis does not automatically edit the document.

---

# M6 — Propagation Workflow

### Objective

Turn impact findings into controlled downstream editing.

### Features

- discuss an impact;
- dismiss impact;
- mark no change needed;
- generate downstream edit;
- review proposed edit;
- accept/reject;
- record impact resolution;
- link downstream change to originating change.

### Acceptance Criteria

- User can trace a downstream change back to the original change.
- Dismissed impacts are preserved as review history.
- Accepted propagation suggestions create new Change Ledger entries.
- New changes can themselves become impact-analysis inputs.

---

# M7 — Decision Memory

### Objective

Persist authorial reasoning independently of chat history.

### Features

- create Decision from conversation;
- create Decision from impact review;
- manual Decision creation;
- scope decisions by document/section;
- search decisions;
- Context Builder retrieves relevant decisions;
- conflict detection between decisions.

### Acceptance Criteria

- User can convert a chat conclusion into a persistent Decision.
- Future AI requests can retrieve applicable decisions.
- The system avoids repeatedly proposing previously rejected propagation.
- Decisions can be edited, superseded, or retired.

---

# M8 — Advanced Document Capabilities

### Possible Features

- comments;
- footnotes;
- citation management;
- richer tables;
- image handling;
- track-change visualization;
- multi-user collaboration;
- Yjs real-time synchronization;
- richer DOCX fidelity;
- PDF reference import;
- bibliography integrations;
- plugin/API ecosystem;
- local desktop application;
- local AI models.

---

# Initial Non-Goals

To protect the first implementation from excessive complexity, the following should not be mandatory for M0–M5:

- Google Docs-style real-time collaboration;
- perfect Word round-trip fidelity;
- complete citation manager;
- full knowledge graph;
- continuous AI monitoring;
- autonomous document rewriting;
- automatic propagation of changes;
- arbitrary plugin marketplace;
- desktop packaging;
- mobile editing;
- OCR;
- layout-engine parity with Microsoft Word.

---

# Key Product Risks

## DOCX fidelity

Microsoft Word documents can contain complex formatting and object models.

Mitigation:

- define supported import/export subset;
- keep internal JSON canonical;
- gradually improve fidelity.

---

## Excessive LLM cost

Mitigation:

- explicit AI invocation;
- retrieval before reasoning;
- lazy indexing;
- change clustering;
- summaries;
- decision memory;
- model routing;
- context caching.

---

## Poor impact-analysis precision

An overly sensitive system may generate too many false positives.

Mitigation:

- confidence thresholds;
- explicit relationship signals;
- user dismissals as feedback;
- distinguish “review recommended” from “change required.”

---

## Poor impact-analysis recall

Some conceptual dependencies may not share vocabulary.

Mitigation:

- semantic retrieval;
- claim extraction;
- summaries;
- citations;
- structural relationships;
- reasoning over clustered changes.

---

## AI overwriting user intent

Mitigation:

- AI always proposes;
- user accepts;
- decisions capture intentional exceptions;
- full provenance.

---

# Success Metrics

Initial technical and product metrics:

```text
Percentage of ordinary editing actions generating LLM calls: 0%

Percentage of AI text changes requiring explicit user acceptance: 100%

Average context size for paragraph-level AI request:
target < 3,000 tokens

Average percentage of document sent for ordinary AI request:
target < 5%

Impact-analysis candidate reduction before reasoning:
target > 80%

Traceability of accepted AI changes to original prompt:
100%

Traceability of propagated changes to source change:
100%
```

Additional quality metrics:

```text
Impact precision
Impact recall
Suggestion acceptance rate
False-positive impact rate
Average reasoning tokens per review
Average cost per 100 document changes
DOCX round-trip fidelity
Time to open large documents
Editing latency
```

---

# Recommended First Prototype

The first working prototype should deliberately focus on a single, complete workflow:

```text
Create/import document
        ↓
Edit normally
        ↓
Select paragraph
        ↓
Ask AI
        ↓
Request modification
        ↓
Review suggested replacement
        ↓
Accept
        ↓
Continue editing manually
        ↓
Create checkpoint
        ↓
Make additional changes
        ↓
Analyze changes
        ↓
See potentially affected later sections
        ↓
Generate proposed downstream changes
        ↓
Accept or reject each change
```

This validates the defining feature of the product without prematurely implementing collaboration, extensive formatting, or a complex graph layer.

---

# Recommended Implementation Order

The architectural dependencies suggest the following order:

```text
Document model
     ↓
Stable node identity
     ↓
Change capture
     ↓
Change Ledger
     ↓
Selection-aware AI
     ↓
Suggestion workflow
     ↓
Hierarchical summaries
     ↓
Semantic retrieval
     ↓
Impact analysis
     ↓
Decision memory
     ↓
Advanced collaboration and integrations
```

Impact analysis should not be implemented before the Change Ledger and stable node identities are reliable.

---

# Core Differentiator

The system's principal differentiator is not generic document generation.

It is the ability to reason over the evolution of a document.

The product knows:

```text
WHAT changed
WHY it changed
WHERE the change occurred
WHICH previous decisions apply
WHAT other text may depend on it
WHETHER the user accepted that implication
HOW a downstream revision originated
```

This converts the document from a passive sequence of text into a structured, change-aware writing environment.

---

# Working Product Definition

> **A change-aware AI writing environment for long-form documents, combining Word-like editing, contextual conversation with selected text, structured change provenance, persistent author decisions, and controlled analysis of how changes propagate across the rest of a document.**

---

# Next Recommended Engineering Artifact

After this specification, the next implementation document should define:

- repository structure;
- detailed PostgreSQL schema;
- Tiptap node extensions;
- stable-ID behavior;
- transaction aggregation algorithm;
- REST or RPC API contracts;
- Context Builder algorithm;
- token-budget logic;
- AI provider abstraction;
- impact candidate-ranking algorithm;
- state machines;
- M0 and M1 engineering tasks;
- automated test strategy.

That document can serve as the initial technical implementation specification for the repository.
