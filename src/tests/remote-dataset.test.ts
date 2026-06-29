import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {sanitize} from '../test-helpers/test-utils';
import {QueryBuilder} from '../queries/QueryBuilder';
import {RemoteDataset} from '../remote/RemoteDataset';
import {toRemoteRequest} from '../remote/RemoteClient';
import type {RemoteRequest} from '../remote/RemoteProtocol';
import type {IDataset} from '../interfaces/IDataset';
import type {SelectQuery} from '../queries/SelectQuery';
import type {CreateQuery} from '../queries/CreateQuery';

/** Fake IDataset that records the (already-lowered) IR it receives. */
class RecordingDataset implements IDataset {
  lastSelect?: SelectQuery;
  lastCreate?: CreateQuery;
  selectCalls = 0;

  async selectQuery(query: SelectQuery): Promise<any> {
    this.selectCalls++;
    this.lastSelect = query;
    return [{id: 'person:1', name: 'Semmy'}];
  }
  async createQuery(query: CreateQuery): Promise<any> {
    this.lastCreate = query;
    return {id: 'person:new-1', name: 'Alice'};
  }
}

/** Simulate the wire: serialize then parse, so we test the JSON-safe payload. */
const overTheWire = (req: RemoteRequest): RemoteRequest =>
  JSON.parse(JSON.stringify(req));

describe('RemoteDataset', () => {
  test('select round-trip — IR equivalence with direct build()', async () => {
    const qb = QueryBuilder.from(Person)
      .select(['name', 'hobby'])
      .where((p: any) => p.name.equals('Semmy'))
      .limit(20);

    const req = overTheWire(toRemoteRequest(qb as any));
    const rec = new RecordingDataset();
    const res = await new RemoteDataset(rec).handle(req);

    expect(res).toMatchObject({ok: true, result: [{id: 'person:1', name: 'Semmy'}]});
    // The IR the wrapped dataset received equals the IR built locally.
    expect(sanitize(rec.lastSelect)).toEqual(sanitize(qb.build()));
  });

  test('select payload is lighter than the equivalent IR', () => {
    const qb = QueryBuilder.from(Person).select(['name', 'hobby']);
    const req = toRemoteRequest(qb as any);
    const dslBytes = JSON.stringify((req as {query: unknown}).query).length;
    const irBytes = JSON.stringify(qb.build()).length;
    expect(dslBytes).toBeLessThan(irBytes);
  });

  test('select — lowering_failed on unknown shape, target untouched', async () => {
    const rec = new RecordingDataset();
    const req: RemoteRequest = {
      op: 'select',
      query: {shape: 'urn:does-not-exist', fields: [{path: 'x'}]} as any,
    };
    const res = await new RemoteDataset(rec).handle(req);

    expect(res).toMatchObject({ok: false, error: {code: 'lowering_failed'}});
    expect(rec.selectCalls).toBe(0);
  });

  test('create round-trip — DSL-JSON lowered to IR equivalent to build()', async () => {
    const builder = (Person as any).create({name: 'Alice', hobby: 'Hiking'});
    const req = overTheWire(toRemoteRequest(builder));
    const rec = new RecordingDataset();
    const res = await new RemoteDataset(rec).handle(req);

    expect(res).toMatchObject({ok: true});
    // The IR the wrapped dataset received equals the IR built locally.
    expect(sanitize(rec.lastCreate)).toEqual(sanitize(builder.build()));
  });

  test('mutation lowering_failed on unknown shape, target untouched', async () => {
    const rec = new RecordingDataset();
    const req: RemoteRequest = {
      op: 'create',
      shape: 'urn:nope',
      data: {shape: 'urn:nope', fields: []},
    } as any;
    const res = await new RemoteDataset(rec).handle(req);

    expect(res).toMatchObject({ok: false, error: {code: 'lowering_failed'}});
    expect(rec.lastCreate).toBeUndefined();
  });

  test('handler_missing when target lacks the optional handler', async () => {
    const selectOnly: IDataset = {
      async selectQuery() {
        return [];
      },
    };
    const req = toRemoteRequest((Person as any).create({name: 'Alice'}));
    const res = await new RemoteDataset(selectOnly).handle(req);

    expect(res).toMatchObject({ok: false, error: {code: 'handler_missing'}});
  });

  test('unsupported_op for an unrecognised op', async () => {
    const res = await new RemoteDataset(new RecordingDataset()).handle(
      {op: 'frobnicate'} as any,
    );
    expect(res).toMatchObject({ok: false, error: {code: 'unsupported_op'}});
  });

  test('execution_failed when the wrapped dataset throws', async () => {
    const throwing: IDataset = {
      async selectQuery() {
        throw new Error('boom');
      },
    };
    const req = toRemoteRequest(
      QueryBuilder.from(Person).select(['name']) as any,
    );
    const res = await new RemoteDataset(throwing).handle(overTheWire(req));

    expect(res).toMatchObject({
      ok: false,
      error: {code: 'execution_failed', message: 'boom'},
    });
  });
});
