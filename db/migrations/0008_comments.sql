-- M8: comments.
--
-- Review remarks anchored to a block, alongside the conversations and findings
-- already anchored there. A comment is a human note, not a proposal: it never
-- edits the document and nothing acts on it automatically.

create table if not exists comments (
    id          text primary key,
    document_id text        not null references documents (id) on delete cascade,
    block_id    text        not null,
    body        text        not null,
    author_id   text        not null default 'usr_local',
    -- open | resolved
    status      text        not null default 'open',
    resolved_by text,
    resolved_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists comments_document_idx
    on comments (document_id, status);

create index if not exists comments_block_idx
    on comments (document_id, block_id);
