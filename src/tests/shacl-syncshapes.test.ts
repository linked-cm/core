/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {setQueryDispatch} from '../queries/queryDispatch';
import {syncShapes} from '../shapes/syncShapes';
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('syncshapes-test');
const ex = (n: string) => ({id: `https://example.org/u#${n}`});

@linkedShape
class TUser extends Shape {
  static targetClass = ex('User');
  @literalProperty({path: ex('name'), minCount: 1, maxCount: 1})
  get name(): string {
    return '';
  }
  @literalProperty({path: ex('status'), in: ['A', 'B']})
  get status(): string {
    return '';
  }
  @objectProperty({path: {seq: [ex('a'), ex('b')]}, shape: TUser})
  get chain(): TUser {
    return null;
  }
}

const ORPHAN = 'https://linked.cm/shape/syncshapes-test/GoneShape';

type Call = {kind: string; id?: string};
let calls: Call[];

function installMock(existingIds: string[]) {
  calls = [];
  setQueryDispatch({
    selectQuery: async () => existingIds.map((id) => ({id})) as any,
    createQuery: async (q: any) => {
      calls.push({kind: 'create', id: q?.data?.id});
      return {} as any;
    },
    updateQuery: async () => ({} as any),
    deleteQuery: async (q: any) => {
      calls.push({kind: 'delete', id: q?.ids?.[0]?.id});
      return {deleted: [], count: 0};
    },
  });
}

describe('syncShapes', () => {
  const userIri = () => TUser.shape.id;

  beforeEach(() => installMock([userIri(), ORPHAN]));

  test('returns an array of thunks', async () => {
    const plan = await syncShapes();
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.every((t) => typeof t === 'function')).toBe(true);
  });

  test('routes create/delete for user shape, delete for orphan, skips framework shapes', async () => {
    const plan = await syncShapes();
    for (const run of plan) await run(); // sequential for deterministic ordering

    const creates = calls.filter((c) => c.kind === 'create').map((c) => c.id);
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);

    // user shape: delete + create
    expect(creates).toContain(userIri());
    expect(deletes).toContain(userIri());
    // orphan: delete only, no create
    expect(deletes).toContain(ORPHAN);
    expect(creates).not.toContain(ORPHAN);
    // framework shapes never synced
    expect(creates).not.toContain('https://linked.cm/shape/core/NodeShape');
    expect(creates).not.toContain('https://linked.cm/shape/core/List');
    expect(deletes).not.toContain('https://linked.cm/shape/core/PropertyShape');
    // base Shape has no packageName and must also be excluded
    expect(creates).not.toContain('https://linked.cm/shape/core/Shape');
  });

  test('per-shape ordering: delete runs before create', async () => {
    const plan = await syncShapes();
    for (const run of plan) await run();
    const delIdx = calls.findIndex((c) => c.kind === 'delete' && c.id === userIri());
    const createIdx = calls.findIndex((c) => c.kind === 'create' && c.id === userIri());
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(delIdx);
  });

  test('builds without error for shapes with sh:in and complex paths', async () => {
    // Exercises rdfList + serializePathToNodeData through the create build inside the thunk.
    const plan = await syncShapes();
    await expect(Promise.all(plan.map((run) => run()))).resolves.toBeDefined();
  });
});
