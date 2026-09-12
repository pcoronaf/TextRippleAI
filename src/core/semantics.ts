/**
 * Lightweight semantic extraction.
 *
 * The spec calls for "simple" definition and claim detection and a lightweight
 * semantic model rather than a formal knowledge graph. These are local pattern
 * rules: they cost nothing, they run on every indexed paragraph, and they are
 * deliberately coarse. Their job is to give impact analysis (M5) something to
 * retrieve on besides raw similarity - an exact definition of a term is a far
 * stronger signal than a paragraph that merely sounds alike.
 *
 * Everything here is recall-oriented and will over-produce. Precision is the
 * reasoning model's job later, not a regular expression's.
 */

export type SemanticUnitType = 'term' | 'definition' | 'claim' | 'citation';

export interface DetectedUnit {
  type: SemanticUnitType;
  /** The term, or the sentence for a claim. */
  value: string;
  /** Supporting text: the defining sentence, or the sentence a term appeared in. */
  context: string;
  /** Which rule fired, so a surprising result can be traced. */
  rule: string;
}

/** Abbreviations that should not end a sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|cf|etc|vs|no|fig|eq|ch|sec|art|para|vol|pp|ed|al)\.$/i;

/** Split into sentences, tolerating common abbreviations. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';

  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    current += (current ? ' ' : '') + piece;
    if (ABBREVIATIONS.test(current.trim())) continue;
    out.push(current.trim());
    current = '';
  }

  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

const DEFINING =
  /^(?:for the purposes of [^,]{3,80},\s*)?["“']?([A-Za-z][\w\s/&()-]{1,60}?)["”']?\s+(means|shall mean|is defined as|are defined as|refers to|denotes)\s+(.{3,})$/i;

const ACRONYM = /\b[A-Z][A-Z0-9]{1,}(?:\/[A-Z0-9]+)*\b/g;
const QUOTED = /["“']([^"”']{3,60})["”']/g;
const CITATION = /(\[\d+\]|\([A-Z][A-Za-z-]+,?\s+\d{4}\)|doi:\S+|ISO\/IEC\s*\d+(?:[-:]\d+)*|IEEE\s*\d+)/g;

/** Modal verbs that make a sentence normative. */
const REQUIREMENT = /\b(shall not|shall|must not|must|is required to|are required to|may not)\b/i;
/** Verbs that make a sentence an assertion about the world. */
const ASSERTIVE =
  /\b(is|are|was|were|increases|decreases|reduces|improves|causes|results in|demonstrates|shows|implies|ensures|prevents)\b/i;

const STOP_STARTS = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'A',
  'An',
  'It',
  'In',
  'For',
  'When',
  'Where',
  'While',
  'If',
  'Although',
  'However',
  'Therefore',
  'Such',
  'Each',
  'Every',
  'Any',
  'All',
  'Some',
  'No',
  'Both',
  'Their',
  'Its',
]);

/** Terms: acronyms, quoted phrases and multi-word proper nouns. */
export function extractTerms(text: string): DetectedUnit[] {
  const found = new Map<string, DetectedUnit>();

  const add = (value: string, context: string, rule: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    if (!found.has(trimmed.toLowerCase())) {
      found.set(trimmed.toLowerCase(), { type: 'term', value: trimmed, context, rule });
    }
  };

  for (const sentence of splitSentences(text)) {
    for (const match of sentence.match(ACRONYM) ?? []) add(match, sentence, 'acronym');

    for (const match of sentence.matchAll(QUOTED)) add(match[1], sentence, 'quoted');

    // Multi-word proper nouns, skipping the sentence's first word - a capital
    // there says nothing beyond "this is where the sentence starts".
    const words = sentence.split(/\s+/);
    let run: string[] = [];
    for (let index = 1; index < words.length; index++) {
      const word = words[index].replace(/[^\w'’/-]/g, '');
      const isProper = /^[A-Z][a-z'’-]+$/.test(word) && !STOP_STARTS.has(word);
      const isConnector = run.length > 0 && /^(of|and|for|the|in)$/.test(word);

      if (isProper || isConnector) {
        run.push(word);
        continue;
      }
      if (run.length >= 2) add(run.join(' ').replace(/\s+(of|and|for|the|in)$/, ''), sentence, 'proper_noun');
      run = [];
    }
    if (run.length >= 2) add(run.join(' ').replace(/\s+(of|and|for|the|in)$/, ''), sentence, 'proper_noun');
  }

  return [...found.values()];
}

/** Definitions: "X means Y", "X is defined as Y", and their relatives. */
export function detectDefinitions(text: string): DetectedUnit[] {
  const out: DetectedUnit[] = [];

  for (const sentence of splitSentences(text)) {
    const match = DEFINING.exec(sentence);
    if (!match) continue;

    const term = match[1].trim().replace(/^(the|a|an)\s+/i, '');
    if (!term || term.split(/\s+/).length > 8) continue;

    out.push({ type: 'definition', value: term, context: sentence, rule: match[2].toLowerCase() });
  }

  return out;
}

/**
 * Claims: normative sentences and assertions about the world.
 *
 * Coarse by design. A sentence carrying a modal verb is a requirement; one
 * carrying an assertive verb or a figure is an assertion. Questions and
 * fragments are skipped.
 */
export function detectClaims(text: string): DetectedUnit[] {
  const out: DetectedUnit[] = [];

  for (const sentence of splitSentences(text)) {
    if (sentence.endsWith('?')) continue;
    if (sentence.split(/\s+/).length < 4) continue;

    if (REQUIREMENT.test(sentence)) {
      out.push({ type: 'claim', value: sentence, context: sentence, rule: 'requirement' });
      continue;
    }
    if (ASSERTIVE.test(sentence) || /\d/.test(sentence)) {
      out.push({ type: 'claim', value: sentence, context: sentence, rule: 'assertion' });
    }
  }

  return out;
}

/** Citations and standard references. */
export function detectCitations(text: string): DetectedUnit[] {
  const found = new Map<string, DetectedUnit>();

  for (const sentence of splitSentences(text)) {
    for (const match of sentence.match(CITATION) ?? []) {
      const value = match.trim();
      if (!found.has(value)) {
        found.set(value, { type: 'citation', value, context: sentence, rule: 'citation' });
      }
    }
  }

  return [...found.values()];
}

/** Everything the local rules can find in one block of text. */
export function extractSemanticUnits(text: string): DetectedUnit[] {
  if (!text.trim()) return [];
  return [
    ...detectDefinitions(text),
    ...detectClaims(text),
    ...extractTerms(text),
    ...detectCitations(text),
  ];
}
