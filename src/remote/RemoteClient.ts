/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {QueryBuilder} from '../queries/QueryBuilder.js';
import type {CreateBuilder} from '../queries/CreateBuilder.js';
import type {UpdateBuilder} from '../queries/UpdateBuilder.js';
import type {DeleteBuilder} from '../queries/DeleteBuilder.js';
import type {RemoteRequest} from './RemoteProtocol.js';

/** Any builder that can be serialized to a {@link RemoteRequest}. */
export type RemoteRequestable =
  | QueryBuilder<any, any, any>
  | CreateBuilder<any, any>
  | UpdateBuilder<any, any, any>
  | DeleteBuilder<any, any>;

/**
 * Client-side payload construction for {@link RemoteDataset}.
 *
 * The serialization boundary is at the *builder* level, not the dataset level:
 * `IDataset` receives already-lowered IR, so the lightweight DSL-JSON must be
 * produced from the builder before the query enters dispatch. Call
 * `toRemoteRequest(builder)` instead of `builder.exec()` (or `await builder`) when
 * you want to ship the query to a remote `RemoteDataset` endpoint.
 *
 * Works for every builder: select queries (`QueryBuilder`) and create/update/delete
 * mutations. Mutation `toJSON()` already carries its `op` discriminator; select is
 * wrapped under `{op: 'select'}`.
 *
 * ```ts
 * const req = toRemoteRequest(QueryBuilder.from(Person).select(['name']));
 * await fetch('/query', {method: 'POST', body: JSON.stringify(req)});
 *
 * const mut = toRemoteRequest(Person.create({name: 'Alice'}));
 * await fetch('/query', {method: 'POST', body: JSON.stringify(mut)});
 * ```
 */
export function toRemoteRequest(builder: RemoteRequestable): RemoteRequest {
  const json = (builder as {toJSON(): unknown}).toJSON();
  if (json && typeof json === 'object' && 'op' in json) {
    // Mutation builders emit a self-describing {op, ...} envelope.
    return json as RemoteRequest;
  }
  // QueryBuilder emits a bare QueryBuilderJSON — wrap it as a select op.
  return {op: 'select', query: json} as RemoteRequest;
}
