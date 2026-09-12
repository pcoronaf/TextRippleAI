'use client';

import { useMemo } from 'react';

import { diffWords } from '@/core/diff';

/** Word-level before/after rendering for a single change. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffWords(before, after), [before, after]);

  if (!before && !after) return <p className="panel-note">Empty block.</p>;

  return (
    <div className="diff">
      {segments.map((segment, index) => {
        if (segment.op === 'insert') return <ins key={index}>{segment.value}</ins>;
        if (segment.op === 'delete') return <del key={index}>{segment.value}</del>;
        return <span key={index}>{segment.value}</span>;
      })}
    </div>
  );
}
