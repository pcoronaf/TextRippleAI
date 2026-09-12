-- M4: hierarchical summaries, block embeddings and locally extracted semantic
-- units, all carrying an explicit freshness status.
--
-- Requires the pgvector extension. It ships with the `pgvector/pgvector:*`
-- images and is available on Neon, Supabase and RDS; on a plain PostgreSQL
-- build, install it before running this migration.

create extension if not exists vector;

create table if not exists summaries (
    id              text primary key,
    document_id     text        not null references documents (id) on delete cascade,
    -- The heading being summarised; null for the document brief.
    node_id         text,
    summary_type    text        not null,
    content         text        not null,
    source_revision integer     not null,
    -- current | stale | potentially_stale
    status          text        not null default 'current',
    provider        text,
    model           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- One summary per node per type. The document brief has a null node_id, which
-- a plain unique constraint would not collapse, so it gets its own index.
create unique index if not exists summaries_node_unique
    on summaries (document_id, summary_type, node_id)
    where node_id is not null;

create unique index if not exists summaries_document_unique
    on summaries (document_id, summary_type)
    where node_id is null;

create index if not exists summaries_status_idx
    on summaries (document_id, status);

create table if not exists embeddings (
    id              text primary key,
    document_id     text        not null references documents (id) on delete cascade,
    node_id         text        not null,
    embedding_type  text        not null default 'block',
    -- Dimension is left unconstrained: it is a property of whichever embedding
    -- model is configured, and exact search needs no index at this scale.
    vector          vector      not null,
    content_hash    text        not null,
    source_revision integer     not null,
    status          text        not null default 'current',
    provider        text,
    model           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (document_id, node_id, embedding_type)
);

create index if not exists embeddings_status_idx
    on embeddings (document_id, status);

create table if not exists semantic_units (
    id              text primary key,
    document_id     text        not null references documents (id) on delete cascade,
    node_id         text        not null,
    -- term | definition | claim | citation
    unit_type       text        not null,
    value           text        not null,
    context         text        not null default '',
    rule            text        not null default '',
    source_revision integer     not null,
    created_at      timestamptz not null default now()
);

create index if not exists semantic_units_node_idx
    on semantic_units (document_id, node_id);

create index if not exists semantic_units_value_idx
    on semantic_units (document_id, unit_type, lower(value));
