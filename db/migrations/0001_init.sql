-- M0 + M1: document core and change ledger.
--
-- Node identity is the primary key everywhere; `position` is an ordering hint
-- and is never treated as identity. The ledger is append-oriented and separate
-- from undo/redo history.

create table if not exists documents (
    id               text primary key,
    workspace_id     text        not null default 'ws_local',
    title            text        not null,
    content          jsonb       not null,
    current_revision integer     not null default 1,
    status           text        not null default 'draft',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table if not exists document_versions (
    id            bigserial primary key,
    document_id   text        not null references documents (id) on delete cascade,
    revision      integer     not null,
    content       jsonb       not null,
    created_by    text        not null,
    created_at    timestamptz not null default now(),
    unique (document_id, revision)
);

create table if not exists document_nodes (
    id           text        not null,
    document_id  text        not null references documents (id) on delete cascade,
    parent_id    text,
    type         text        not null,
    position     integer     not null,
    -- The revision at which this node's content last changed, not the document
    -- revision: untouched paragraphs keep their revision when neighbours move.
    revision     integer     not null,
    text         text        not null,
    content_hash text        not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (document_id, id)
);

create index if not exists document_nodes_order_idx
    on document_nodes (document_id, position);

-- Exact-terminology retrieval, one half of the M4 hybrid search.
create index if not exists document_nodes_fts_idx
    on document_nodes using gin (to_tsvector('english', text));

create table if not exists checkpoints (
    id          text primary key,
    document_id text        not null references documents (id) on delete cascade,
    name        text        not null,
    revision    integer     not null,
    created_by  text        not null,
    created_at  timestamptz not null default now()
);

create index if not exists checkpoints_document_idx
    on checkpoints (document_id, revision desc);

create table if not exists changes (
    id             text primary key,
    document_id    text        not null references documents (id) on delete cascade,
    block_id       text        not null,
    block_type     text        not null,
    author_id      text        not null,
    source         text        not null,
    operation      text        not null,
    classification text        not null,
    before_content text        not null default '',
    after_content  text        not null default '',
    before_hash    text        not null,
    after_hash     text        not null,
    session_id     text        not null,
    revision       integer     not null,
    checkpoint_id  text references checkpoints (id) on delete set null,
    impact_status  text        not null default 'pending',
    -- Provenance for AI-assisted changes (M3 onwards).
    prompt         text,
    model          text,
    suggestion_id  text,
    occurred_at    timestamptz not null,
    created_at     timestamptz not null default now()
);

create index if not exists changes_document_revision_idx
    on changes (document_id, revision desc, created_at desc);

create index if not exists changes_checkpoint_idx
    on changes (document_id, checkpoint_id);

create index if not exists changes_block_idx
    on changes (document_id, block_id);
