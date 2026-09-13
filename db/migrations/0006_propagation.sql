-- M6: propagation.
--
-- A proposal that exists because of an impact finding carries a link back to
-- it. Combined with the links already in place - change -> suggestion, impact
-- -> source changes - that completes the chain a reader needs to answer "why
-- does this paragraph read the way it does".

alter table suggestions
    add column if not exists source_impact_id text references impacts (id) on delete set null;

create index if not exists suggestions_source_impact_idx
    on suggestions (document_id, source_impact_id);

-- A conversation may be anchored to an impact finding, so the discussion about
-- a consequence lives with the consequence.
create index if not exists conversations_impact_idx
    on conversations (document_id, related_impact_id);
