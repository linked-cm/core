/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery} from '../queries/DeleteQuery.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {lowerMutationJSON} from '../queries/MutationSerialization.js';
import {fail, run, type RemoteRequest, type RemoteResponse} from './RemoteProtocol.js';

/**
 * Server-side adapter that receives a {@link RemoteRequest} over the wire and
 * delegates to a wrapped {@link IDataset}.
 *
 * For `select`, the request carries the lightweight DSL-JSON
 * (`QueryBuilderJSON`); this adapter lowers it to canonical IR with the public
 * pipeline (`QueryBuilder.fromJSON(json).build()`) and hands the wrapped dataset
 * exactly the IR it already expects — keeping `json -> IR -> SPARQL` translation
 * on the dataset side. Mutations carry IR and are passed straight through.
 *
 * The server MUST have the relevant SHACL shapes registered: lowering resolves
 * property labels to IRIs and recovers cardinality from the shape. An
 * unregistered shape/label surfaces as a `lowering_failed` response rather than
 * an unhandled throw.
 *
 * ```ts
 * const endpoint = new RemoteDataset(new FusekiDataset(...));
 * app.post('/query', async (req, res) => res.json(await endpoint.handle(req.body)));
 * ```
 */
export class RemoteDataset {
  constructor(private readonly target: IDataset) {}

  /** Lower (if needed) and delegate one wire request to the wrapped dataset. */
  async handle(req: RemoteRequest): Promise<RemoteResponse> {
    switch (req?.op) {
      case 'select': {
        let ir: SelectQuery;
        try {
          ir = QueryBuilder.fromJSON(req.query).build();
        } catch (err) {
          return fail('lowering_failed', err);
        }
        return run('execution_failed', () => this.target.selectQuery(ir));
      }
      case 'create': {
        if (!this.target.createQuery) {
          return fail('handler_missing', 'target IDataset does not implement createQuery');
        }
        let ir: CreateQuery;
        try {
          ir = lowerMutationJSON(req) as CreateQuery;
        } catch (err) {
          return fail('lowering_failed', err);
        }
        return run('execution_failed', () => this.target.createQuery!(ir));
      }
      case 'update': {
        if (!this.target.updateQuery) {
          return fail('handler_missing', 'target IDataset does not implement updateQuery');
        }
        let ir: UpdateQuery;
        try {
          ir = lowerMutationJSON(req) as UpdateQuery;
        } catch (err) {
          return fail('lowering_failed', err);
        }
        return run('execution_failed', () => this.target.updateQuery!(ir));
      }
      case 'delete': {
        if (!this.target.deleteQuery) {
          return fail('handler_missing', 'target IDataset does not implement deleteQuery');
        }
        let ir: DeleteQuery;
        try {
          ir = lowerMutationJSON(req) as DeleteQuery;
        } catch (err) {
          return fail('lowering_failed', err);
        }
        return run('execution_failed', () => this.target.deleteQuery!(ir));
      }
      default:
        return fail('unsupported_op', `unsupported op: ${String((req as {op?: unknown})?.op)}`);
    }
  }
}
