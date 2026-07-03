/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, test, expect} from '@jest/globals';
import '../utils/Package';
import '../ontologies/rdf';
import '../ontologies/xsd';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';

const entity = (suffix: string) => ({id: `${tmpEntityBase}${suffix}`});

// G2 / D3 (Rung 1): oneOf / notOneOf membership → SPARQL IN / NOT IN.
const sparqlOf = (q: unknown) => selectToSparql(lower(q as never) as never);

describe('oneOf / notOneOf (Rung 1 membership)', () => {
  test('literal oneOf → IN (list)', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.hobby.oneOf(['Chess', 'Go'])),
    );
    expect(sparql).toContain('IN ("Chess", "Go")');
    expect(sparql).not.toContain('NOT IN');
  });

  test('literal notOneOf → NOT IN (list)', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.hobby.notOneOf(['Golf'])),
    );
    expect(sparql).toContain('NOT IN ("Golf")');
  });

  test('named-node oneOf → IN (<iri>, <iri>)', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) =>
        p.bestFriend.oneOf([entity('p1'), entity('p2')]),
      ),
    );
    expect(sparql).toContain('IN (');
    expect(sparql).toContain('p1>');
    expect(sparql).toContain('p2>');
  });

  test('empty oneOf → matches nothing (FILTER(false))', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.hobby.oneOf([])),
    );
    expect(sparql).toContain('FILTER(false)');
  });

  test('empty notOneOf → matches everything (FILTER(true))', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.hobby.notOneOf([])),
    );
    expect(sparql).toContain('FILTER(true)');
  });
});
