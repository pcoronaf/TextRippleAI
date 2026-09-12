-- M2: conversations anchored to document nodes, with per-message token logging.

create table if not exists conversations (
    id                text primary key,
    document_id       text        not null references documents (id) on delete cascade,
    -- The node the conversation hangs off. Null means document-level.
    anchor_block_id   text,
    selection_from    integer,
    selection_to      integer,
    selection_text    text        not null default '',
    title             text        not null default '',
    -- Reserved for M3/M5: a conversation may also anchor to a change or an impact.
    related_change_id text,
    related_impact_id text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create index if not exists conversations_document_idx
    on conversations (document_id, updated_at desc);

create index if not exists conversations_anchor_idx
    on conversations (document_id, anchor_block_id);

create table if not exists messages (
    id              text primary key,
    conversation_id text        not null references conversations (id) on delete cascade,
    role            text        not null,
    content         text        not null,
    provider        text,
    model           text,
    input_tokens    integer     not null default 0,
    output_tokens   integer     not null default 0,
    -- The exact context package sent with a user turn, so "Show AI context"
    -- can report what left the machine rather than an approximation.
    context_digest  jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
    on messages (conversation_id, created_at asc);
