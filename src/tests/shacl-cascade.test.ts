/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {deleteToSparql, updateToSparql, buildOwnedCascade} from '../sparql/irToAlgebra';
import type {IRDeleteMutation, IRUpdateMutation} from '../queries/IntermediateRepresentation';
// Ensure List/PathNode (dependent shapes) are registered so the cascade has targets.
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('cascade-test');
const ex = (n: string) => ({id: `http://example.org/c#${n}`});

@linkedShape({dependent: true})
class TCell extends Shape {
  static targetClass = ex('TCell');
  @objectProperty({path: ex('next'), shape: TCell, maxCount: 1, contains: true})
  get next(): TCell {
    return null;
  }
}

@linkedShape
class TBox extends Shape {
  static targetClass = ex('TBox');
  @objectProperty({path: ex('owns'), shape: TCell, maxCount: 1, contains: true})
  get owns(): TCell {
    return null;
  }
  @objectProperty({path: ex('ref'), shape: TCell, maxCount: 1})
  get ref(): TCell {
    return null;
  }
}

@linkedShape
class TBag extends Shape {
  static targetClass = ex('TBag');
  @objectProperty({path: ex('items'), shape: TCell, contains: true})
  get items(): TCell[] {
    return [];
  }
}

describe('owned-subtree cascade', () => {
  test('delete cascades via contains edges to dependent-typed nodes', () => {
    const sparql = deleteToSparql(
      DeleteBuilder.from(TBox, {id: 'http://example.org/c#b1'}).build() as IRDeleteMutation,
    );
    // follows contains edges as a one-or-more property path
    expect(sparql).toContain('owns');
    expect(sparql).toContain('next');
    expect(sparql).toMatch(/\)\+ /); // (…|…)+ property path
    // only deletes reached nodes asserted to be a dependent type
    expect(sparql).toContain('http://example.org/c#TCell');
  });

  test('safety: non-contains predicate (ref) is NOT followed by the cascade', () => {
    const sparql = deleteToSparql(
      DeleteBuilder.from(TBox, {id: 'http://example.org/c#b1'}).build() as IRDeleteMutation,
    );
    expect(sparql).not.toContain('#ref');
  });

  test('cascade includes rdf:rest (List spine) and PathNode/List dependent types', () => {
    const {deletePatterns, whereOptionals} = buildOwnedCascade(
      {kind: 'iri', value: 'http://example.org/c#b1'},
      't_',
    );
    expect(deletePatterns.length).toBeGreaterThan(0);
    // one OPTIONAL per dependent type; the path term carries the contains predicates
    const paths = whereOptionals
      .flatMap((o: any) => o.triples)
      .filter((t: any) => t.predicate.kind === 'path')
      .map((t: any) => t.predicate.value);
    expect(paths.join(' ')).toMatch(/rest/); // List.rest is a contains edge
    const types = whereOptionals
      .flatMap((o: any) => o.triples)
      .filter((t: any) => t.predicate.kind === 'iri' && t.predicate.value.endsWith('#type'))
      .map((t: any) => t.object.value);
    expect(types).toEqual(expect.arrayContaining([
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#List',
      'https://linked.cm/ont/linked-core/PathNode',
      'http://example.org/c#TCell',
    ]));
  });

  test('update set-modification remove on a contains property cascades the removed subtree', () => {
    const sparql = updateToSparql(
      UpdateBuilder.from(TBag)
        .for('http://example.org/c#bag1')
        .set({items: {remove: [{id: 'http://example.org/c#oldcell'}]}} as any)
        .build() as IRUpdateMutation,
    );
    // the removed value is a cascade root, followed by the contains property path
    expect(sparql).toContain('http://example.org/c#oldcell');
    expect(sparql).toMatch(/\)\+ /);
    expect(sparql).toContain('http://example.org/c#TCell');
  });

  test('update replacing a contains property cascades the old value subtree', () => {
    const sparql = updateToSparql(
      UpdateBuilder.from(TBox)
        .for('http://example.org/c#b1')
        .set({owns: {id: 'http://example.org/c#newcell'}})
        .build() as IRUpdateMutation,
    );
    // DELETE removes the old owns edge AND the old owned subtree (cascade path present)
    expect(sparql).toContain('owns');
    expect(sparql).toMatch(/\)\+ /);
    expect(sparql).toContain('http://example.org/c#TCell');
  });
});
