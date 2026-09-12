-- M5: impact analysis.
--
-- An analysis reads the ledger and the index and writes findings. It never
-- writes document content - turning a finding into a proposal is M6, and that
-- goes through the suggestion workflow like every other AI edit.

create table if not exists impact_analyses (
    id                 text primary key,
    document_id        text        not null references documents (id) on delete cascade,
    base_checkpoint_id text references checkpoints (id) on delete set null,
    target_revision    integer     not null,
    -- running | completed | failed
    status             text        not null default 'running',
    summary            text        not null default '',
    -- The conceptual changes the ledger entries collapsed into, and how much of
    -- the document survived retrieval. Kept so a briefing can be re-read later
    -- without re-running anything.
    clusters           jsonb       not null default '[]'::jsonb,
    retrieval          jsonb       not null default '{}'::jsonb,
    changes_analysed   integer     not null default 0,
    changes_filtered   integer     not null default 0,
    provider           text,
    model              text,
    input_tokens       integer     not null default 0,
    output_tokens      integer     not null default 0,
    error              text,
    created_at         timestamptz not null default now(),
    completed_at       timestamptz
);

create index if not exists impact_analyses_document_idx
    on impact_analyses (document_id, created_at desc);

create table if not exists impacts (
    id                 text primary key,
    impact_analysis_id text        not null references impact_analyses (id) on delete cascade,
    document_id        text        not null references documents (id) on delete cascade,
    source_change_ids  text[]      not null default '{}',
    source_cluster_id  text        not null default '',
    target_block_id    text        not null,
    target_text        text        not null default '',
    impact_type        text        not null,
    confidence         real        not null default 0,
    severity           text        not null,
    explanation        text        not null default '',
    recommended_action text        not null,
    -- pending | dismissed | accepted_no_change | needs_review | generate_suggestion
    status             text        not null default 'pending',
    suggestion_id      text references suggestions (id) on delete set null,
    resolved_by        text,
    resolved_at        timestamptz,
    created_at         timestamptz not null default now()
);

create index if not exists impacts_analysis_idx
    on impacts (impact_analysis_id, severity);

create index if not exists impacts_document_idx
    on impacts (document_id, status);

create index if not exists impacts_target_idx
    on impacts (document_id, target_block_id);
