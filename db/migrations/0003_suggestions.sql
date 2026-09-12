-- M3: AI proposals, held separately from the authoritative document.
--
-- A suggestion never touches the document. Acceptance is what creates a
-- revision and a ledger entry, and the ledger entry points back here.

create table if not exists suggestions (
    id                    text primary key,
    document_id           text        not null references documents (id) on delete cascade,
    block_id              text        not null,
    conversation_id       text references conversations (id) on delete set null,
    instruction           text        not null,
    -- The block's text when the proposal was made. Acceptance compares against
    -- this, so a proposal cannot be applied to a passage that has since moved on.
    before_content        text        not null,
    proposed_content      text        not null,
    rationale             text        not null default '',
    selection_start       integer,
    selection_end         integer,
    status                text        not null default 'generated',
    provider              text,
    model                 text,
    input_tokens          integer     not null default 0,
    output_tokens         integer     not null default 0,
    context_digest        jsonb,
    parent_suggestion_id  text references suggestions (id) on delete set null,
    base_revision         integer     not null,
    change_id             text,
    resolved_by           text,
    resolved_at           timestamptz,
    created_at            timestamptz not null default now()
);

create index if not exists suggestions_document_idx
    on suggestions (document_id, created_at desc);

create index if not exists suggestions_block_idx
    on suggestions (document_id, block_id, status);
