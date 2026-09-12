import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve('src');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/g)].map(
    (match) => match[1] ?? match[2],
  );

/**
 * Design rule 2: editing and AI reasoning are separate, and normal typing must
 * never trigger a model request.
 *
 * That is a property of the dependency graph, not of a code path, so it is
 * checked as one. If the editing path ever gains a route to the AI layer, this
 * fails before anyone has to notice a surprise invoice.
 */
describe('editing path is independent of the AI layer', () => {
  const EDITING_PATH = ['core', 'editor', 'store', 'formats'];
  const FORBIDDEN = ['@/ai', 'openai', '@anthropic-ai/sdk'];

  for (const area of EDITING_PATH) {
    it(`src/${area} does not reach the AI layer`, () => {
      const offenders: string[] = [];

      for (const file of filesUnder(path.join(SRC, area))) {
        for (const specifier of importsOf(file)) {
          const forbidden = FORBIDDEN.some(
            (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
          );
          if (forbidden) offenders.push(`${path.relative(SRC, file)} -> ${specifier}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  }

  it('the AI layer is reached only from API routes and the sidebar', () => {
    const callers = new Set<string>();

    for (const file of filesUnder(SRC)) {
      const relative = path.relative(SRC, file).replace(/\\/g, '/');
      if (relative.startsWith('ai/')) continue;
      if (importsOf(file).some((specifier) => specifier.startsWith('@/ai'))) {
        callers.add(relative);
      }
    }

    for (const caller of callers) {
      const allowed =
        caller.startsWith('app/api/') ||
        caller.startsWith('components/') ||
        caller === 'server/http.ts';
      expect(allowed, `${caller} imports the AI layer`).toBe(true);
    }
  });
});

/**
 * Design rule 1: the document is authoritative. Nothing may write model output
 * into the document without the author accepting it, so the AI layer must not
 * be able to reach the store at all.
 */
describe('the AI layer cannot write to the document', () => {
  it('src/ai does not import the store', () => {
    const offenders: string[] = [];

    for (const file of filesUnder(path.join(SRC, 'ai'))) {
      for (const specifier of importsOf(file)) {
        if (specifier === '@/store' || specifier.startsWith('@/store/')) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
