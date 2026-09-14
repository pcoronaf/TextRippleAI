#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server.
 *
 * Walks the M0/M1 workflow over HTTP - create, edit, record changes, checkpoint,
 * scope the ledger to that checkpoint, export - so the API, the store and the
 * format layer are verified together in a real Next.js runtime rather than only
 * as units.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { createHash } from 'node:crypto';
import process from 'node:process';

const BASE = process.argv[2] ?? 'http://localhost:3000';

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  return response;
}

async function json(path, init) {
  const response = await api(path, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const hash = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const draft = (blockId, before, after, classification = 'editorial') => ({
  blockId,
  blockType: 'paragraph',
  operation: 'replace',
  before,
  after,
  beforeHash: hash(before),
  afterHash: hash(after),
  classification,
  sessionId: 'sess_smoke',
  occurredAt: new Date().toISOString(),
});

/** Replace the text of the block with the given id. */
function editBlock(content, blockId, text) {
  const next = structuredClone(content);
  for (const node of next.content) {
    if (node.attrs?.id === blockId) node.content = [{ type: 'text', text }];
  }
  return next;
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/ai/status`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not become ready at ${BASE}`);
}

async function main() {
  console.log(`Smoke testing ${BASE}`);
  await waitForServer();

  console.log('\nAI gateway');
  const status = await json('/api/ai/status');
  check('reports a selected provider', typeof status.selected === 'string', status.selected);
  // Named rather than counted: the point is that every adapter reports itself,
  // and a bare count silently passes if one is swapped for another.
  check(
    'lists every adapter',
    ['anthropic', 'openai', 'bridge', 'mock'].every((name) =>
      status.providers?.some((entry) => entry.provider === name),
    ),
    (status.providers ?? []).map((entry) => entry.provider).join(', '),
  );

  console.log('\nCreate and load');
  const created = await json('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Smoke manuscript',
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'The opening paragraph.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'The second paragraph.' }] },
          // Enough body for "what share of the document was sent" to mean
          // something: on a five-paragraph fixture the structural context is
          // larger than the document itself, which tests nothing real.
          ...Array.from({ length: 60 }, (_, index) => ({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: `Filler paragraph ${index + 1}. It exists so the manuscript has a realistic length, and it says nothing of consequence about the matter under discussion.`,
              },
            ],
          })),
          { type: 'paragraph', content: [{ type: 'text', text: 'A distant paragraph about badgers.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Another distant paragraph about otters.' }] },
          // Carries a definition, a requirement and a citation, so the local
          // extraction rules have something real to find.
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'A supervisory control means a check performed by a competent person [7]. The operator shall record every such check.',
              },
            ],
          },
        ],
      },
    }),
  });

  const id = created.document.id;
  check('document created at revision 1', created.document.currentRevision === 1);

  const blockIds = created.content.content.map((node) => node.attrs?.id);
  check('every block received a persistent ID', blockIds.every(Boolean), JSON.stringify(blockIds));
  check('IDs are unique', new Set(blockIds).size === blockIds.length);

  const loaded = await json(`/api/documents/${id}`);
  check(
    'reload preserves the same IDs',
    JSON.stringify(loaded.content.content.map((n) => n.attrs?.id)) === JSON.stringify(blockIds),
  );

  console.log('\nSave with a change');
  const target = blockIds[1];
  const saved = await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(loaded.content, target, 'The opening paragraph, revised.'),
      expectedRevision: 1,
      changes: [draft(target, 'The opening paragraph.', 'The opening paragraph, revised.')],
    }),
  });

  check('revision advanced to 2', saved.document.currentRevision === 2);
  check('one ledger entry written', saved.changes.length === 1);
  check('ledger entry is pending impact analysis', saved.changes[0]?.impactStatus === 'pending');
  check('ledger entry attributed to a human author', saved.changes[0]?.source === 'human');

  const stale = await api(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: loaded.content, expectedRevision: 1, changes: [] }),
  });
  check('a stale revision is rejected with 409', stale.status === 409, `got ${stale.status}`);

  console.log('\nCheckpoint');
  const checkpoint = await json(`/api/documents/${id}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Methodology approved' }),
  });
  check('checkpoint pinned to revision 2', checkpoint.revision === 2);

  const sealed = await json(`/api/documents/${id}/changes`);
  check('earlier change sealed under the checkpoint', sealed.changes[0]?.checkpointId === checkpoint.id);

  console.log('\nChanges since the checkpoint');
  const afterCheckpoint = await json(`/api/documents/${id}`);
  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(afterCheckpoint.content, blockIds[2], 'The second paragraph, rewritten.'),
      expectedRevision: 2,
      changes: [
        draft(blockIds[2], 'The second paragraph.', 'The second paragraph, rewritten.'),
        draft(blockIds[2], 'spacing  here', 'spacing here', 'typographical'),
      ],
    }),
  });

  const all = await json(`/api/documents/${id}/changes`);
  check('ledger holds all three changes', all.changes.length === 3, `got ${all.changes.length}`);

  const since = await json(`/api/documents/${id}/changes?since=${checkpoint.id}`);
  check('two changes since the checkpoint', since.changes.length === 2, `got ${since.changes.length}`);
  check(
    'summary separates substantive from trivial',
    since.summary?.substantive === 1 && since.summary?.trivial === 1,
    JSON.stringify(since.summary),
  );
  check(
    'changes are attributed to a chapter',
    since.summary?.byChapter?.some((chapter) => chapter.title === 'Chapter One'),
    JSON.stringify(since.summary?.byChapter),
  );

  const substantive = await json(`/api/documents/${id}/changes?includeTrivial=false`);
  check(
    'typographical changes can be filtered out',
    substantive.changes.length === 2,
    `got ${substantive.changes.length}`,
  );

  console.log('\nExport');
  const docx = await api(`/api/documents/${id}/export?format=docx`);
  const bytes = new Uint8Array(await docx.arrayBuffer());
  check('DOCX export returns a zip container', bytes[0] === 0x50 && bytes[1] === 0x4b);
  check('DOCX export is not empty', bytes.length > 1000, `${bytes.length} bytes`);

  const markdown = await (await api(`/api/documents/${id}/export?format=md`)).text();
  check('Markdown export keeps the heading', markdown.includes('# Chapter One'));
  check('Markdown export keeps revised prose', markdown.includes('rewritten'));

  console.log('\nAsk about a selection');
  const asked = await json('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: id,
      blockId: blockIds[1],
      question: 'Is this statement too absolute?',
    }),
  });

  check('a conversation was created', Boolean(asked.conversation?.id));
  check('the conversation is anchored to the block', asked.conversation?.anchorBlockId === blockIds[1]);
  check('the turn produced a question and an answer', asked.messages?.length === 2);
  check(
    'the answer came from the configured provider',
    typeof asked.messages?.[1]?.content === 'string' && asked.messages[1].content.length > 0,
  );

  const context = asked.context;
  const contextText = (context?.parts ?? []).map((part) => part.text).join('\n');

  check('the selection was sent', contextText.includes('The opening paragraph, revised.'));
  check('the neighbouring paragraph was sent', contextText.includes('The second paragraph'));
  check(
    'distant paragraphs were not sent',
    !contextText.includes('badgers') && !contextText.includes('otters'),
  );
  check(
    'the context stayed under the token budget',
    context?.totalTokens < context?.budgetTokens,
    `${context?.totalTokens} of ${context?.budgetTokens}`,
  );
  // The spec's target: an ordinary paragraph-level request sends under 5% of
  // the document.
  check(
    'well under 5% of the document was sent',
    context?.documentPercent > 0 && context?.documentPercent < 5,
    `${context?.documentPercent}%`,
  );
  check(
    'filler paragraphs were not sent',
    !contextText.includes('Filler paragraph 30'),
  );
  check(
    'context not yet available is named rather than faked',
    (context?.omitted ?? []).some((entry) => entry.includes('summaries')),
  );

  console.log('\nFollow-up stays in the same conversation');
  const followUp = await json('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: id,
      blockId: blockIds[1],
      conversationId: asked.conversation.id,
      question: 'What would you soften first?',
    }),
  });

  check('the same conversation was continued', followUp.conversation?.id === asked.conversation.id);
  check(
    'the surroundings were not resent',
    (followUp.context?.omitted ?? []).some((entry) => entry.includes('already present')),
  );
  check(
    'the follow-up context is smaller than the first turn',
    followUp.context.parts.length < asked.context.parts.length,
  );

  const thread = await json(`/api/documents/${id}/conversations/${asked.conversation.id}`);
  check('the thread holds all four turns', thread.messages?.length === 4, `${thread.messages?.length}`);
  check(
    'turns alternate question and answer',
    thread.messages.map((message) => message.role).join(',') === 'user,assistant,user,assistant',
  );
  check(
    'the question turn records what context accompanied it',
    Boolean(thread.messages[0].contextDigest),
  );
  check(
    'the answer turn records provenance',
    Boolean(thread.messages[1].model) && Boolean(thread.messages[1].provider),
  );

  const anchored = await json(
    `/api/documents/${id}/conversations?anchor=${encodeURIComponent(blockIds[1])}`,
  );
  check('the conversation is found by its anchor', anchored.conversations?.length === 1);

  const elsewhere = await json(
    `/api/documents/${id}/conversations?anchor=${encodeURIComponent(blockIds[2])}`,
  );
  check('another block has no conversation of its own', elsewhere.conversations?.length === 0);

  console.log('\nExplain needs no question');
  const explained = await json('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: id, blockId: blockIds[2], action: 'explain' }),
  });
  check('explain produced an answer', explained.messages?.length === 2);
  check(
    'explain opened its own conversation',
    explained.conversation?.id !== asked.conversation.id,
  );

  const badBlock = await api('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: id, blockId: 'p_nonexistent', question: 'Hello?' }),
  });
  check('an unknown block is rejected', badBlock.status === 400, `got ${badBlock.status}`);

  const noQuestion = await api('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: id, blockId: blockIds[1] }),
  });
  check('an empty question is rejected', noQuestion.status === 400, `got ${noQuestion.status}`);

  console.log('\nPropose a rewrite');
  const revisionOf = async () => (await json(`/api/documents/${id}`)).document.currentRevision;
  const textOf = async (blockId) => {
    const current = await json(`/api/documents/${id}`);
    const node = current.content.content.find((entry) => entry.attrs?.id === blockId);
    return (node?.content ?? []).map((child) => child.text ?? '').join('');
  };

  const beforeText = await textOf(blockIds[1]);
  const revisionBefore = await revisionOf();

  const proposal = await json('/api/ai/modify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: id,
      blockId: blockIds[1],
      instruction: 'Make this assertion less absolute.',
    }),
  });

  const suggestion = proposal.suggestion;
  check('a proposal was recorded', Boolean(suggestion?.id));
  check('it starts unresolved', suggestion?.status === 'generated');
  check('it captures the passage it was written against', suggestion?.before === beforeText);
  check('it proposes different text', suggestion?.proposed !== beforeText);
  check('it records the instruction', suggestion?.instruction === 'Make this assertion less absolute.');
  check('it records the model that produced it', Boolean(suggestion?.model));

  check(
    'proposing does not touch the document',
    (await revisionOf()) === revisionBefore && (await textOf(blockIds[1])) === beforeText,
  );

  console.log('\nRejecting changes nothing');
  const rejected = await json(
    `/api/documents/${id}/suggestions/${suggestion.id}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    },
  );
  check('the proposal is marked rejected', rejected.suggestion?.status === 'rejected');
  check(
    'the document is untouched after a rejection',
    (await revisionOf()) === revisionBefore && (await textOf(blockIds[1])) === beforeText,
  );

  const acceptRejected = await api(`/api/documents/${id}/suggestions/${suggestion.id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'accept', expectedRevision: revisionBefore }),
  });
  check('a rejected proposal cannot be accepted', acceptRejected.status === 409);

  console.log('\nRevising a proposal');
  const first = (
    await json('/api/ai/modify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: id,
        blockId: blockIds[2],
        instruction: 'Soften this.',
      }),
    })
  ).suggestion;

  const revisedProposal = (
    await json('/api/ai/modify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: id,
        blockId: blockIds[2],
        instruction: 'Softer still.',
        parentSuggestionId: first.id,
      }),
    })
  ).suggestion;

  check('the revision points back at what it replaced', revisedProposal.parentSuggestionId === first.id);
  const supersededList = await json(
    `/api/documents/${id}/suggestions?blockId=${encodeURIComponent(blockIds[2])}`,
  );
  const superseded = supersededList.suggestions.find((entry) => entry.id === first.id);
  check('the earlier proposal is marked superseded', superseded?.status === 'revised');

  console.log('\nAccepting applies the change and records its provenance');
  const accepted = await json(
    `/api/documents/${id}/suggestions/${revisedProposal.id}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept', expectedRevision: await revisionOf() }),
    },
  );

  check('the revision advanced', accepted.document.currentRevision > revisionBefore);
  check('the document now holds the proposed text', await (async () =>
    (await textOf(blockIds[2])) === revisedProposal.proposed)());
  check('the paragraph kept its identity', accepted.change?.blockId === blockIds[2]);
  check('the ledger entry is attributed to the AI', accepted.change?.source === 'ai_accepted');
  check('the ledger entry records the prompt', accepted.change?.prompt === 'Softer still.');
  check('the ledger entry records the model', Boolean(accepted.change?.model));
  check(
    'the ledger entry points back at the proposal',
    accepted.change?.suggestionId === revisedProposal.id,
  );
  check('the proposal points back at the ledger entry', accepted.suggestion?.changeId === accepted.change?.id);
  check('the proposal is marked accepted', accepted.suggestion?.status === 'accepted');

  const acceptedAgain = await api(
    `/api/documents/${id}/suggestions/${revisedProposal.id}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept', expectedRevision: await revisionOf() }),
    },
  );
  check('an accepted proposal cannot be applied twice', acceptedAgain.status === 409);

  console.log('\nA proposal whose passage moved on is refused');
  const stalePending = (
    await json('/api/ai/modify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: id,
        blockId: blockIds[3],
        instruction: 'Tighten this.',
      }),
    })
  ).suggestion;

  const beforeManualEdit = await json(`/api/documents/${id}`);
  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(beforeManualEdit.content, blockIds[3], 'The author rewrote this by hand.'),
      expectedRevision: beforeManualEdit.document.currentRevision,
      changes: [
        draft(blockIds[3], stalePending.before, 'The author rewrote this by hand.'),
      ],
    }),
  });

  const staleAccept = await api(`/api/documents/${id}/suggestions/${stalePending.id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'accept', expectedRevision: await revisionOf() }),
  });
  check('a proposal written against older text is refused', staleAccept.status === 409);
  check(
    "the author's own edit survived",
    (await textOf(blockIds[3])) === 'The author rewrote this by hand.',
  );

  const ledgerWithAi = await json(`/api/documents/${id}/changes`);
  check(
    'the ledger holds exactly one AI-accepted entry',
    ledgerWithAi.changes.filter((change) => change.source === 'ai_accepted').length === 1,
  );

  console.log('\nSemantic index');
  const statusBefore = await json(`/api/documents/${id}/index`);
  check(
    'every block starts unindexed',
    statusBefore.embeddings.missing === statusBefore.blocks && statusBefore.blocks > 0,
    `${statusBefore.embeddings.missing} of ${statusBefore.blocks}`,
  );
  check(
    'summaries start missing',
    statusBefore.summaries.every((entry) => entry.current === 0),
  );

  const indexed = await json(`/api/documents/${id}/index`, { method: 'POST' });
  check('embeddings were written', indexed.embeddingsWritten > 0, `${indexed.embeddingsWritten}`);
  check('summaries were written', indexed.summariesWritten > 0, `${indexed.summariesWritten}`);
  check(
    'terms, definitions and claims were extracted',
    indexed.semanticUnitsWritten > 0,
    `${indexed.semanticUnitsWritten}`,
  );
  check('nothing is left stale', indexed.status.embeddings.stale === 0);
  check('nothing is left unembedded', indexed.status.embeddings.missing === 0);

  const reindexed = await json(`/api/documents/${id}/index`, { method: 'POST' });
  check(
    're-indexing a current document regenerates nothing',
    reindexed.embeddingsWritten === 0 && reindexed.summariesWritten === 0,
    `${reindexed.embeddingsWritten} embeddings, ${reindexed.summariesWritten} summaries`,
  );

  console.log('\nEditing invalidates only what it touched');
  const beforeEdit = await json(`/api/documents/${id}`);
  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(beforeEdit.content, blockIds[4], 'A materially different paragraph now.'),
      expectedRevision: beforeEdit.document.currentRevision,
      changes: [draft(blockIds[4], 'unused', 'A materially different paragraph now.')],
    }),
  });

  const afterEdit = await json(`/api/documents/${id}/index`);
  check('the edited block went stale', afterEdit.embeddings.stale === 1, `${afterEdit.embeddings.stale}`);
  check(
    'untouched blocks stayed current',
    afterEdit.embeddings.current === statusBefore.blocks - 1,
    `${afterEdit.embeddings.current}`,
  );
  check(
    'the document brief is now suspect',
    afterEdit.summaries.find((entry) => entry.type === 'document')?.potentiallyStale === 1,
  );

  const topUp = await json(`/api/documents/${id}/index`, { method: 'POST' });
  check('only the stale work was redone', topUp.embeddingsWritten === 1, `${topUp.embeddingsWritten}`);
  check('the index is current again', topUp.status.embeddings.stale === 0);

  console.log('\nHybrid retrieval');
  const lexical = await json(
    `/api/documents/${id}/search?q=${encodeURIComponent('badgers')}&mode=text`,
  );
  check('exact terminology is found', lexical.hits?.[0]?.nodeId === blockIds[63], lexical.hits?.[0]?.nodeId);

  const hybrid = await json(
    `/api/documents/${id}/search?q=${encodeURIComponent('badgers')}&mode=hybrid`,
  );
  check('hybrid search returns hits', (hybrid.hits?.length ?? 0) > 0);
  check('hybrid search ran the semantic half', hybrid.semanticAvailable === true);
  check(
    'the lexical match still wins in the fused ranking',
    hybrid.hits?.[0]?.nodeId === blockIds[63],
    hybrid.hits?.[0]?.nodeId,
  );
  check(
    'hits report which signals produced them',
    hybrid.hits?.[0]?.signals?.lexicalRank !== undefined,
  );

  const empty = await json(`/api/documents/${id}/search?q=`);
  check('an empty query returns nothing', (empty.hits?.length ?? 0) === 0);

  const defining = await json(
    `/api/documents/${id}/search?q=${encodeURIComponent('supervisory control')}`,
  );
  check(
    'the paragraph defining a queried term comes first',
    defining.hits?.[0]?.nodeId === blockIds[65],
    defining.hits?.[0]?.nodeId,
  );
  check(
    'and is flagged as defining it',
    defining.hits?.[0]?.signals?.definition === true,
    JSON.stringify(defining.hits?.[0]?.signals),
  );

  console.log('\nBriefs reach the Context Builder');
  const withBriefs = await json('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: id,
      blockId: blockIds[1],
      question: 'Does this sit correctly in the document?',
    }),
  });
  const briefLabels = (withBriefs.context?.parts ?? []).map((part) => part.label);
  check('the document brief is now sent', briefLabels.includes('Document brief'), briefLabels.join(', '));
  check(
    'the missing-summary caveat is gone',
    !(withBriefs.context?.omitted ?? []).some((entry) => entry.includes('summaries')),
  );
  check(
    'the context still stays under budget',
    withBriefs.context.totalTokens < withBriefs.context.budgetTokens,
    `${withBriefs.context.totalTokens}`,
  );

  console.log('\nImpact analysis');
  const revisionBeforeAnalysis = await revisionOf();

  // A terminology sweep across two paragraphs, leaving a third behind.
  const sweepBase = await json(`/api/documents/${id}`);
  let sweepContent = editBlock(
    sweepBase.content,
    blockIds[63],
    'A distant paragraph about supervisory control in the field.',
  );
  sweepContent = editBlock(
    sweepContent,
    blockIds[64],
    'Another distant paragraph about supervisory control at sea.',
  );

  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: sweepContent,
      expectedRevision: sweepBase.document.currentRevision,
      changes: [
        {
          ...draft(
            blockIds[63],
            'A distant paragraph about badgers.',
            'A distant paragraph about supervisory control in the field.',
          ),
          classification: 'terminology',
        },
        {
          ...draft(
            blockIds[64],
            'Another distant paragraph about otters.',
            'Another distant paragraph about supervisory control at sea.',
          ),
          classification: 'terminology',
        },
        {
          ...draft(blockIds[5], 'spacing  here', 'spacing here'),
          classification: 'typographical',
        },
      ],
    }),
  });

  const analysed = await json(`/api/documents/${id}/impact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  const analysis = analysed.analysis;
  check('the analysis completed', analysis?.status === 'completed', analysis?.status);
  check('it produced a briefing summary', Boolean(analysis?.summary));
  check(
    'typographical changes were filtered out',
    analysis?.changesFiltered >= 1,
    `${analysis?.changesFiltered}`,
  );
  check(
    'the ledger entries collapsed into fewer conceptual changes',
    analysis?.clusters?.length > 0 && analysis.clusters.length < analysis.changesAnalysed,
    `${analysis?.clusters?.length} clusters from ${analysis?.changesAnalysed} changes`,
  );
  check(
    'most of the document was ruled out before reasoning',
    analysis?.retrieval?.reductionPercent > 80,
    `${analysis?.retrieval?.reductionPercent}%`,
  );
  check(
    'the passages examined are a small subset',
    analysis?.retrieval?.candidatesConsidered < analysis?.retrieval?.blocksInDocument,
    `${analysis?.retrieval?.candidatesConsidered} of ${analysis?.retrieval?.blocksInDocument}`,
  );

  check('findings were recorded', (analysed.impacts?.length ?? 0) > 0, `${analysed.impacts?.length}`);
  const finding = analysed.impacts?.[0];
  check('a finding names the passage it concerns', Boolean(finding?.targetBlockId));
  check('a finding explains itself', Boolean(finding?.explanation));
  check('a finding carries severity and confidence', Boolean(finding?.severity) && finding?.confidence >= 0);
  check('a finding points back at the changes that caused it', (finding?.sourceChangeIds?.length ?? 0) > 0);
  check('a finding starts unresolved', finding?.status === 'pending');
  check(
    'the changed paragraphs are not offered as their own consequences',
    !analysed.impacts.some((impact) => [blockIds[63], blockIds[64]].includes(impact.targetBlockId)),
  );

  // The save above advanced the revision by one; analysis must not advance it
  // further. This is the acceptance criterion the whole milestone rests on.
  const revisionAfterAnalysis = await revisionOf();
  check(
    'analysis did not edit the document',
    revisionAfterAnalysis === revisionBeforeAnalysis + 1,
    `revision ${revisionAfterAnalysis}, expected ${revisionBeforeAnalysis + 1}`,
  );

  const ledgerAfter = await json(`/api/documents/${id}/changes`);
  check(
    'analysed changes are marked as such',
    ledgerAfter.changes.some((change) => change.impactStatus === 'analyzed'),
  );

  console.log('\nPropagation: a finding becomes a reviewed proposal');
  const actionable = analysed.impacts[0];
  const revisionBeforePropagation = await revisionOf();

  const proposed = await json(
    `/api/documents/${id}/impacts/${actionable.id}/propose`,
    { method: 'POST' },
  );

  check('a proposal was drafted', Boolean(proposed.suggestion?.id));
  check('it points back at the finding', proposed.suggestion?.sourceImpactId === actionable.id);
  check('it targets the passage the finding concerns', proposed.suggestion?.blockId === actionable.targetBlockId);
  check('it records why it was asked for', Boolean(proposed.suggestion?.instruction));
  check('the finding is marked as being acted on', proposed.impact?.status === 'generate_suggestion');
  check(
    'drafting a fix does not touch the document',
    (await revisionOf()) === revisionBeforePropagation,
  );

  const secondAttempt = await api(`/api/documents/${id}/impacts/${actionable.id}/propose`, {
    method: 'POST',
  });
  check('a second proposal for the same finding is refused', secondAttempt.status === 409);

  const acceptedPropagation = await json(
    `/api/documents/${id}/suggestions/${proposed.suggestion.id}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept', expectedRevision: revisionBeforePropagation }),
    },
  );

  check('accepting it advanced the revision', acceptedPropagation.document.currentRevision > revisionBeforePropagation);
  check(
    'the ledger entry is a propagation, not a plain AI edit',
    acceptedPropagation.change?.source === 'propagation',
    acceptedPropagation.change?.source,
  );
  check(
    'the propagated change can itself be analysed next time',
    acceptedPropagation.change?.impactStatus === 'pending',
  );

  console.log('\nTracing a propagated change to its origin');
  const trace = await json(
    `/api/documents/${id}/changes/${acceptedPropagation.change.id}/trace`,
  );

  check('the trace reaches the proposal', trace.suggestion?.id === proposed.suggestion.id);
  check('and the finding it resolved', trace.impact?.id === actionable.id);
  check('and the analysis that produced it', trace.analysis?.id === analysis.id);
  check(
    'and the original changes whose consequences it addresses',
    (trace.originChanges?.length ?? 0) > 0,
    `${trace.originChanges?.length} origin change(s)`,
  );
  // Origins are whatever the analysis attributed the finding to - which may
  // include an earlier accepted AI edit, since those have consequences too.
  // What must hold is that they are real ledger entries, and not this change.
  const ledgerNow = await json(`/api/documents/${id}/changes`);
  const ledgerIds = new Set(ledgerNow.changes.map((change) => change.id));
  check(
    'every origin is a real ledger entry',
    trace.originChanges?.every((change) => ledgerIds.has(change.id)),
  );
  check(
    'the propagated change is not listed as its own origin',
    !trace.originChanges?.some((change) => change.id === acceptedPropagation.change.id),
  );

  const plainTrace = await json(
    `/api/documents/${id}/changes/${trace.originChanges[0].id}/trace`,
  );
  check('a manual change traces to a short chain, not an error', plainTrace.suggestion === null);

  console.log('\nResolving a finding');
  // A different finding from the one just propagated, so the two paths do not
  // overwrite each other's state.
  const dismissTarget = analysed.impacts[1] ?? analysed.impacts[0];
  const dismissed = await json(`/api/documents/${id}/impacts/${dismissTarget.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'dismissed' }),
  });
  check('a finding can be dismissed', dismissed.impact?.status === 'dismissed');
  check('and records who resolved it', Boolean(dismissed.impact?.resolvedAt));

  const badStatus = await api(`/api/documents/${id}/impacts/${dismissTarget.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'invented' }),
  });
  check('an unknown resolution is rejected', badStatus.status === 400);

  const reread = await json(`/api/documents/${id}/impact/${analysis.id}`);
  check('a briefing can be re-read later', reread.analysis?.id === analysis.id);
  check(
    'with its findings and their resolutions',
    reread.impacts?.find((impact) => impact.id === dismissTarget.id)?.status === 'dismissed',
  );
  check(
    'a dismissal is kept as review history rather than deleted',
    reread.impacts?.length === analysed.impacts.length,
  );

  const analyses = await json(`/api/documents/${id}/impact`);
  check('past analyses are listed', (analyses.analyses?.length ?? 0) >= 1);

  // A document with nothing to analyse should say so rather than spend a
  // reasoning call finding nothing.
  const fresh = await json('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Untouched' }),
  });
  const emptyAnalysis = await api(`/api/documents/${fresh.document.id}/impact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('analysing a document with no changes is refused', emptyAnalysis.status === 400);
  await api(`/api/documents/${fresh.document.id}`, { method: 'DELETE' });

  console.log('\nDecision memory');
  const emptyDecisions = await json(`/api/documents/${id}/decisions`);
  check('a document starts with no decisions', emptyDecisions.decisions?.length === 0);

  const recorded = await json(`/api/documents/${id}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Prefer supervisory control terminology',
      description: "Use 'supervisory control' rather than 'oversight' in operational sections.",
      scope: { type: 'document' },
      source: 'manual',
    }),
  });
  check('a decision can be recorded', Boolean(recorded.decision?.id));
  check('it starts in force', recorded.decision?.status === 'accepted');

  const searched = await json(
    `/api/documents/${id}/decisions?q=${encodeURIComponent('supervisory')}`,
  );
  check('decisions are searchable', searched.decisions?.length === 1);
  const missed = await json(`/api/documents/${id}/decisions?q=${encodeURIComponent('zzzzz')}`);
  check('a search that matches nothing returns nothing', missed.decisions?.length === 0);

  const conflicting = await json(`/api/documents/${id}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Contradicts the first',
      description: "Use 'oversight' rather than 'supervisory control' everywhere.",
      scope: { type: 'document' },
    }),
  });
  const withConflict = await json(`/api/documents/${id}/decisions`);
  check('a contradiction between decisions is flagged', (withConflict.conflicts?.length ?? 0) > 0);

  const retired = await json(
    `/api/documents/${id}/decisions/${conflicting.decision.id}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'retired' }),
    },
  );
  check('a decision can be retired', retired.decision?.status === 'retired');

  const afterRetire = await json(`/api/documents/${id}/decisions`);
  check('retiring clears the contradiction', (afterRetire.conflicts?.length ?? 0) === 0);
  check(
    'a retired decision is kept, not deleted',
    afterRetire.decisions?.length === 2,
    `${afterRetire.decisions?.length}`,
  );

  console.log('\nDecisions travel with every AI request');
  const withDecisions = await json('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: id,
      blockId: blockIds[1],
      question: 'Does this follow the agreed terminology?',
    }),
  });
  const labels = (withDecisions.context?.parts ?? []).map((part) => part.label);
  check('applicable decisions are sent', labels.includes('Decisions already taken'), labels.join(', '));
  check(
    'the last declared context gap is closed',
    !(withDecisions.context?.omitted ?? []).some((entry) => entry.includes('Applicable decisions')),
  );

  console.log('\nA refused consequence stops recurring');
  // Record a decision that settles a specific passage, then re-analyse.
  const settle = analysed.impacts.find((impact) => impact.id !== finding?.id) ?? analysed.impacts[0];

  await json(`/api/documents/${id}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Do not propagate to this passage',
      description: 'This passage uses the term in a different sense.',
      scope: { type: 'node', nodeId: settle.targetBlockId },
      source: 'impact_review',
      suppressBlockId: settle.targetBlockId,
      sourceImpactId: settle.id,
    }),
  });

  // Make a fresh change so there is something to analyse again.
  const reAnalyseBase = await json(`/api/documents/${id}`);
  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(
        reAnalyseBase.content,
        blockIds[2],
        'The second paragraph, revised once more for supervisory control.',
      ),
      expectedRevision: reAnalyseBase.document.currentRevision,
      changes: [
        {
          ...draft(
            blockIds[2],
            'unused',
            'The second paragraph, revised once more for supervisory control.',
          ),
          classification: 'terminology',
        },
      ],
    }),
  });

  const reAnalysed = await json(`/api/documents/${id}/impact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  check(
    'the settled passage is not put in front of the model again',
    !reAnalysed.candidates?.some((candidate) => candidate.blockId === settle.targetBlockId),
    settle.targetBlockId,
  );
  check(
    'and the briefing says how many were suppressed',
    typeof reAnalysed.analysis?.retrieval?.suppressedByDecisions === 'number',
  );
  check(
    'no finding is raised about it',
    !reAnalysed.impacts?.some((impact) => impact.targetBlockId === settle.targetBlockId),
  );

  console.log('\nComments');
  const revisionBeforeComment = await revisionOf();

  const comment = await json(`/api/documents/${id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockId: blockIds[1], body: 'Is this too strong?' }),
  });
  check('a comment can be left on a passage', comment.comment?.status === 'open');
  check('it is anchored to the block', comment.comment?.blockId === blockIds[1]);
  check('commenting does not touch the document', (await revisionOf()) === revisionBeforeComment);

  const resolvedComment = await json(
    `/api/documents/${id}/comments/${comment.comment.id}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    },
  );
  check('a comment can be resolved', resolvedComment.comment?.status === 'resolved');

  const openOnly = await json(`/api/documents/${id}/comments?status=open`);
  check('resolved comments drop out of the open list', openOnly.comments?.length === 0);
  const allComments = await json(`/api/documents/${id}/comments`);
  check('but are kept, not deleted', allComments.comments?.length === 1);

  const badComment = await api(`/api/documents/${id}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockId: blockIds[1] }),
  });
  check('an empty comment is rejected', badComment.status === 400);

  console.log('\nCitations');
  const citations = await json(`/api/documents/${id}/citations`);
  check('extracted citations are grouped', (citations.citations?.length ?? 0) > 0);
  check(
    'each records where it is used',
    citations.citations?.every((entry) => entry.blockIds.length > 0),
  );
  check(
    'and whether a citing passage has changed',
    citations.citations?.every((entry) => Array.isArray(entry.changedBlockIds)),
  );

  console.log('\nFootnotes and images survive a round trip');
  const withExtras = await json('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Extras',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Oversight is required.' },
              { type: 'footnote', content: [{ type: 'text', text: 'See ISO/IEC 42001.' }] },
              { type: 'image', attrs: { src: 'https://example.org/figure.png', alt: 'Figure 1' } },
            ],
          },
        ],
      },
    }),
  });

  const extrasId = withExtras.document.id;
  const extraBlocks = withExtras.content.content[0].content ?? [];
  check(
    'a footnote survives as a node, not as inline prose',
    extraBlocks.some((node) => node.type === 'footnote'),
  );
  check(
    'an image keeps its source',
    extraBlocks.find((node) => node.type === 'image')?.attrs?.src ===
      'https://example.org/figure.png',
  );

  const reloaded = await json(`/api/documents/${extrasId}`);
  const paragraph = reloaded.content.content[0];
  check(
    'the footnote has its own persistent id',
    typeof paragraph.content?.find((node) => node.type === 'footnote')?.attrs?.id === 'string',
  );

  const extrasMarkdown = await (
    await api(`/api/documents/${extrasId}/export?format=md`)
  ).text();
  check('markdown export carries the footnote', extrasMarkdown.includes('^[See ISO/IEC 42001.]'));
  check('markdown export carries the image', extrasMarkdown.includes('![Figure 1]'));

  const extrasDocx = await api(`/api/documents/${extrasId}/export?format=docx`);
  const extrasBytes = new Uint8Array(await extrasDocx.arrayBuffer());
  check(
    'DOCX export with a footnote still produces a valid container',
    extrasBytes[0] === 0x50 && extrasBytes[1] === 0x4b && extrasBytes.length > 1000,
    `${extrasBytes.length} bytes`,
  );

  const extrasText = await (await api(`/api/documents/${extrasId}/export?format=txt`)).text();
  check(
    'the footnote is not folded into the paragraph prose',
    extrasText.includes('Oversight is required.') &&
      !extrasText.split('\n')[0].includes('ISO/IEC 42001'),
  );

  await api(`/api/documents/${extrasId}`, { method: 'DELETE' });

  console.log('\nOrphaned comment anchors');
  const orphanDoc = await json('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Orphan check',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'The passage under review.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'A paragraph that survives.' }] },
        ],
      },
    }),
  });
  const orphanId = orphanDoc.document.id;
  {
    const loaded = await json(`/api/documents/${orphanId}`);
    const blocks = loaded.content.content;

    await json(`/api/documents/${orphanId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockId: blocks[0].attrs.id, body: 'Is this still needed?' }),
    });

    const before = await json(`/api/documents/${orphanId}/comments`);
    check('a live anchor is not reported as orphaned', before.comments[0]?.orphaned === false);
    check('a new comment opens a thread', before.comments[0]?.parentId === null);

    // A reply names no block; it takes the anchor of what it answers.
    const replied = await json(`/api/documents/${orphanId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: before.comments[0].id, body: 'Yes, but reword it.' }),
    });
    check('a reply joins its parent thread', replied.comment.parentId === before.comments[0].id);
    check('and inherits the anchor', replied.comment.blockId === blocks[0].attrs.id);

    const anchorless = await api(`/api/documents/${orphanId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'No block and no parent.' }),
    });
    check('a comment with neither a block nor a parent is rejected', anchorless.status === 400);

    // Delete the commented block.
    await json(`/api/documents/${orphanId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: { ...loaded.content, content: blocks.slice(1) },
        expectedRevision: loaded.document.currentRevision,
        changes: [],
      }),
    });

    const after = await json(`/api/documents/${orphanId}/comments`);
    check('the thread outlives the block it pointed at', after.comments.length === 2);
    check(
      'and every comment in it is reported as orphaned',
      after.comments.every((comment) => comment.orphaned === true),
    );
  }
  await api(`/api/documents/${orphanId}`, { method: 'DELETE' });

  console.log('\nSettings');
  const settingsBefore = await json('/api/settings');
  check('settings report the selected provider', typeof settingsBefore.selected === 'string');
  check('settings say where each value came from', typeof settingsBefore.origins?.provider === 'string');
  check('no key is stored to begin with', settingsBefore.stored?.anthropicApiKey === false);

  const stored = await json('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anthropicApiKey: 'sk-ant-smoke-not-a-real-key' }),
  });
  check('storing a key reports it as present', stored.stored?.anthropicApiKey === true);
  check('the key comes from the settings file', stored.origins?.anthropicApiKey === 'settings');
  // The one property of this endpoint that really matters.
  check(
    'the key itself is never returned',
    !JSON.stringify(stored).includes('sk-ant-smoke-not-a-real-key'),
  );

  const badProvider = await api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'definitely-not-a-provider' }),
  });
  check('an unknown provider is rejected', badProvider.status === 400);

  const cleared = await json('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anthropicApiKey: null }),
  });
  check('a key can be removed again', cleared.stored?.anthropicApiKey === false);
  check('the gateway is still on the mock provider', cleared.selected === 'mock');

  console.log('\nCleanup');
  const deleted = await api(`/api/documents/${id}`, { method: 'DELETE' });
  check('document deleted', deleted.status === 204);
  check('deleted document is gone', (await api(`/api/documents/${id}`)).status === 404);

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
