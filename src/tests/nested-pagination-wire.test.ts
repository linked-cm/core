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
import {QueryBuilder} from '../queries/QueryBuilder';

// G10: nested-select pagination (limit/offset/orderBy) must survive toJSON/fromJSON.
describe('G10 — nested-select pagination survives the wire', () => {
  test('inner .limit/.offset/.orderBy are emitted and rehydrated', () => {
    const q = QueryBuilder.from(Person).select((p: any) =>
      p.friends
        .select((f: any) => f.name)
        .offset(1)
        .limit(2)
        .orderBy('name', 'DESC'),
    );
    const json = q.toJSON();

    // The relation carries its pagination options in the wire form.
    const friendsField = json.fields!.find(
      (f) => typeof f !== 'string' && 'friends' in (f as object),
    ) as any;
    expect(friendsField).toBeDefined();
    const spec = friendsField.friends;
    expect(spec.limit).toBe(2);
    expect(spec.offset).toBe(1);
    expect(spec.orderBy).toEqual([{name: 'DESC'}]);

    // Rehydrate and confirm the entry keeps the pagination (was silently dropped).
    const restored = QueryBuilder.fromJSON(json as any);
    const entry = (restored as any)
      ._fieldsWithPreloads()
      .entries.find((e: any) => e.innerLimit !== undefined);
    expect(entry).toBeDefined();
    expect(entry.innerLimit).toBe(2);
    expect(entry.innerOffset).toBe(1);
    expect(entry.innerOrderBy[0].direction).toBe('DESC');
  });
});
