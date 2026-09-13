/**
 * Persistent identifiers.
 *
 * Design principle: stable identity is more important than text position.
 * Every meaningful document element carries an ID that survives edits; text
 * offsets never serve as identity.
 */

/** Prefix per node type, so IDs are self-describing in logs and ledger rows. */
const NODE_PREFIXES: Record<string, string> = {
  doc: 'doc',
  heading: 'h',
  paragraph: 'p',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  blockquote: 'quote',
  codeBlock: 'code',
  table: 'tbl',
  tableRow: 'tr',
  tableCell: 'td',
  tableHeader: 'th',
  image: 'fig',
  horizontalRule: 'hr',
};

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomToken(length: number): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  let out = '';
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** A new prefixed identifier, e.g. `chg_4k2p9wq1zt`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken(10)}`;
}

/** A new identifier for a document node, prefixed by its node type. */
export function newNodeId(nodeType: string): string {
  return newId(NODE_PREFIXES[nodeType] ?? 'n');
}

export const newDocumentId = () => newId('doc');
export const newChangeId = () => newId('chg');
export const newCheckpointId = () => newId('cp');
export const newSessionId = () => newId('sess');
export const newSuggestionId = () => newId('sug');
export const newConversationId = () => newId('conv');
export const newMessageId = () => newId('msg');
export const newSuggestionRecordId = () => newId('sug');
export const newSummaryId = () => newId('sum');
export const newEmbeddingId = () => newId('emb');
export const newSemanticUnitId = () => newId('unit');
export const newImpactAnalysisId = () => newId('ia');
export const newImpactId = () => newId('imp');
export const newDecisionId = () => newId('dec');
export const newCommentId = () => newId('cmt');
