/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, test, expect} from '@jest/globals';
import '../utils/Package';
import '../ontologies/rdf';
import '../ontologies/xsd';
import {Person} from '../test-helpers/query-fixtures';
import {entity, captureDslIR} from '../test-helpers/test-utils';
import {createToSparql} from '../sparql/irToAlgebra';
import {isSetModificationValue} from '../queries/QueryFactory';
import {Expr} from '../expressions/Expr';

// Report 021 §3 — mutation-input correctness fixes (G4, G6, G7).

describe('G4 — expression value in create fails loudly (not silently dropped)', () => {
  test('a computed value in create throws at lowering to SPARQL', async () => {
    const ir = await captureDslIR(() =>
      Person.create({name: 'Bob', birthDate: Expr.now() as never}),
    );
    expect(() => createToSparql(ir as never)).toThrow(
      /Computed\/expression values are not supported in create/,
    );
  });

  test('a plain literal create still works', async () => {
    const ir = await captureDslIR(() => Person.create({name: 'Bob', hobby: 'Chess'}));
    const sparql = createToSparql(ir as never);
    expect(sparql).toContain('INSERT DATA');
    expect(sparql).toContain('"Bob"');
  });
});

describe('G6 — null mutation value does not crash', () => {
  test('isSetModificationValue(null) is false, not a TypeError', () => {
    expect(() => isSetModificationValue(null)).not.toThrow();
    expect(isSetModificationValue(null)).toBe(false);
    // and a real set-mod is still recognized
    expect(isSetModificationValue({$add: [{id: 'x'}]})).toBe(true);
  });
});

describe('G7 — add/remove mixed with other keys is not silently dropped', () => {
  test('{add:[…], name:"x"} is not misclassified as a bare set-modification', async () => {
    // Previously `hasAdd || …` short-circuited the key-count check and silently
    // dropped `name`; now the mixed shape is rejected loudly.
    await expect(
      captureDslIR(() =>
        Person.update({friends: {add: [entity('p2')], name: 'x'}} as never).for(entity('p1')),
      ),
    ).rejects.toThrow();
  });

  test('a clean {add:[…]} set-modification still works', async () => {
    await expect(
      captureDslIR(() =>
        Person.update({friends: {add: [entity('p2')]}} as never).for(entity('p1')),
      ),
    ).resolves.toBeDefined();
  });
});
