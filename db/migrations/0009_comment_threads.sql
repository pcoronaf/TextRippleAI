-- Comments become threads.
--
-- A reply is a comment with a parent. Keeping replies in the same table means
-- the anchor, the status lifecycle and the "nothing is ever deleted" rule are
-- inherited rather than reimplemented, and a thread is reconstructed by
-- grouping on the root rather than by storing an order that could drift.
--
-- A reply is anchored to the same block as its parent; the column stays on the
-- row so that a reply is still addressable on its own.

alter table comments
    add column if not exists parent_id text references comments (id) on delete cascade;

create index if not exists comments_parent_idx
    on comments (parent_id);
