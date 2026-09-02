/**
 * Golden tests for the SPARQL ASK pipeline:
 *   query factory → IR → algebra → SPARQL string
 *
 * `.exists()` normalises the query before dispatching, so these capture the IR
 * that normalisation produces and run it through `askToSparql`. Every fixture
 * here has a `SELECT … LIMIT 1` twin in `sparql-select-golden.test.ts`: the two
 * forms are the same WHERE body, and that is asserted directly below.
 */
import {describe, expect, test} from '@jest/globals';
import {existsFactories, queryFactories} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {askToAlgebra, askToSparql, selectToSparql} from '../sparql/irToAlgebra';
import {askPlanToSparql} from '../sparql/algebraToString';
import {setQueryContext} from '../queries/QueryContext';
import {Person} from '../test-helpers/query-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: 'user-1'}, Person);

const P = 'https://linked.cm/shape/core/Person';

const goldenAsk = async (factory: () => Promise<unknown>): Promise<string> => {
  const ir = await captureQuery(factory);
  return askToSparql(ir);
};

// ---------------------------------------------------------------------------
// Golden output
// ---------------------------------------------------------------------------

describe('SPARQL golden — ASK', () => {
  test('existsById', async () => {
    const sparql = await goldenAsk(existsFactories.existsById);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <${P}> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}`);
  });

  test('existsWhere', async () => {
    const sparql = await goldenAsk(existsFactories.existsWhere);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <${P}> .
  ?a0 <${P}/name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}`);
  });

  test('no projection, no solution modifiers reach the output', async () => {
    for (const factory of Object.values(existsFactories)) {
      const sparql = await goldenAsk(factory);
      expect(sparql).toContain('ASK WHERE {');
      expect(sparql).not.toContain('SELECT');
      expect(sparql).not.toContain('LIMIT');
      expect(sparql).not.toContain('OFFSET');
      expect(sparql).not.toContain('ORDER BY');
      expect(sparql).not.toContain('DISTINCT');
    }
  });

  test('existsNormalised / existsPaginated collapse onto existsById', async () => {
    const bare = await goldenAsk(existsFactories.existsById);
    expect(await goldenAsk(existsFactories.existsNormalised)).toBe(bare);
    expect(await goldenAsk(existsFactories.existsPaginated)).toBe(bare);
  });
});

// ---------------------------------------------------------------------------
// ASK and the SELECT degradation ask the same question
// ---------------------------------------------------------------------------

describe('ASK ≡ SELECT … LIMIT 1 (same WHERE body)', () => {
  // The degradation in `askViaSelect` is only sound if both forms carry the
  // identical pattern. Strip each form's envelope and compare the bodies.
  const body = (sparql: string): string =>
    sparql
      .replace(/^ASK WHERE \{\n/m, '')
      .replace(/^SELECT[^\n]*\nWHERE \{\n/m, '')
      .replace(/\n\}(\nLIMIT 1)?$/m, '');

  test.each(Object.keys(existsFactories))(
    '%s — ASK body matches the SELECT body',
    async (name) => {
      const factory = (existsFactories as Record<string, () => Promise<unknown>>)[name];
      const ask = await goldenAsk(factory);
      const select = selectToSparql(await captureQuery(factory));
      expect(body(ask)).toBe(body(select));
      expect(select).toContain('LIMIT 1');
    },
  );
});

// ---------------------------------------------------------------------------
// Modifiers that could change the answer are rejected, not dropped
// ---------------------------------------------------------------------------

describe('askToAlgebra — modifier guards', () => {
  const irFor = async (factory: () => Promise<unknown>) =>
    (await captureQuery(factory)) as any;

  test('OFFSET is rejected rather than silently dropped', async () => {
    const ir = await irFor(existsFactories.existsById);
    expect(() => askToAlgebra({...ir, offset: 5})).toThrow(/OFFSET/);
  });

  test('LIMIT 0 is rejected — SELECT LIMIT 0 and ASK disagree', async () => {
    const ir = await irFor(existsFactories.existsById);
    expect(() => askToAlgebra({...ir, limit: 0})).toThrow(/LIMIT 0/);
    // The guard exists because these two genuinely differ:
    expect(selectToSparql({...ir, limit: 0})).toContain('LIMIT 0');
  });

  test('a limit of 1 or more is a harmless bound and is ignored', async () => {
    const ir = await irFor(existsFactories.existsById);
    expect(askPlanToSparql(askToAlgebra({...ir, limit: 1}))).toBe(
      askPlanToSparql(askToAlgebra({...ir, limit: 50})),
    );
  });

  test('ORDER BY and the projection cannot change a boolean and are ignored', async () => {
    const decorated = await irFor(queryFactories.selectName);
    // An un-normalised IR still produces a valid ASK — the projection's OPTIONAL
    // triples come along (documented on askToAlgebra) but no modifiers do.
    const sparql = askToSparql(decorated);
    expect(sparql).toContain('ASK WHERE {');
    expect(sparql).not.toContain('ORDER BY');
    expect(sparql).not.toContain('SELECT');
  });
});
