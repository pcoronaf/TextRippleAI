-- M7: decision memory.
--
-- Persistent authorial intent, kept out of chat history so the Context Builder
-- and impact analysis can find it. A decision never edits the document; its
-- effect is on what the system proposes next.

create table if not exists decisions (
    id                     text primary key,
    document_id            text        not null references documents (id) on delete cascade,
    title                  text        not null,
    description            text        not null default '',
    -- {"type":"document"} | {"type":"node","nodeId":...} | {"type":"from_node","nodeId":...}
    scope                  jsonb       not null default '{"type":"document"}'::jsonb,
    -- accepted | superseded | retired
    status                 text        not null default 'accepted',
    -- manual | conversation | impact_review
    source                 text        not null default 'manual',
    -- What this decision settles, so analysis stops re-raising it.
    suppress_block_id      text,
    suppress_terms         text[]      not null default '{}',
    suppress_impact_type   text,
    source_impact_id       text references impacts (id) on delete set null,
    source_conversation_id text references conversations (id) on delete set null,
    supersedes_decision_id text references decisions (id) on delete set null,
    created_by             text        not null default 'usr_local',
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create index if not exists decisions_document_idx
    on decisions (document_id, status);

create index if not exists decisions_suppress_idx
    on decisions (document_id, suppress_block_id)
    where suppress_block_id is not null;

-- Free-text search over the reasoning, for the decisions sidebar.
create index if not exists decisions_fts_idx
    on decisions using gin (to_tsvector('english', title || ' ' || description));
