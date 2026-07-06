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
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {specFixtures} from './dsl-json-spec-fixtures';

// Ensure the shape referenced by the fixtures is registered.
void Person;

// Spec-conformance gate: every documented DSL-JSON example (mirrored in
// dsl-json-spec-fixtures.ts) must decode via fromJSON and lower to SPARQL.
describe('DSL-JSON spec conformance — documented examples decode & lower', () => {
  for (const fx of specFixtures) {
    test(fx.doc, () => {
      const builder = fromJSON(fx.json() as never);
      const ir = lower(builder as never);
      const sparql = selectToSparql(ir as never);
      expect(typeof sparql).toBe('string');
      expect(sparql.length).toBeGreaterThan(0);
      for (const token of fx.sparqlIncludes) {
        expect(sparql).toContain(token);
      }
    });
  }
});
