/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {shacl} from '../ontologies/shacl';
import {coreOntology} from '../ontologies/linked-core';

const SH = 'http://www.w3.org/ns/shacl#';
const LC = 'https://linked.cm/ont/linked-core/';

describe('ontology terms', () => {
  test('shacl predicates present', () => {
    expect(shacl.equals.id).toBe(`${SH}equals`);
    expect(shacl.disjoint.id).toBe(`${SH}disjoint`);
    expect(shacl.hasValue.id).toBe(`${SH}hasValue`);
    expect(shacl.order.id).toBe(`${SH}order`);
    expect(shacl.group.id).toBe(`${SH}group`);
    expect(shacl.closed.id).toBe(`${SH}closed`);
    expect(shacl.ignoredProperties.id).toBe(`${SH}ignoredProperties`);
  });

  test('linked-core terms present', () => {
    expect(coreOntology.contains.id).toBe(`${LC}contains`);
    expect(coreOntology.dependent.id).toBe(`${LC}dependent`);
    expect(coreOntology.PathNode.id).toBe(`${LC}PathNode`);
  });
});
