/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {QueryBuilder} from '../queries/QueryBuilder.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery} from '../queries/DeleteQuery.js';
import type {RemoteRequest} from './RemoteProtocol.js';

/**
 * Client-side payload construction for {@link RemoteDataset}.
 *
 * The serialization boundary is at the *builder* level, not the dataset level:
 * `IDataset` receives already-lowered IR, so the lightweight DSL-JSON must be
 * produced from the `QueryBuilder` before the query enters dispatch. Call
 * `toRemoteRequest(qb)` instead of `qb.exec()` when you want to ship the query to
 * a remote `RemoteDataset` endpoint.
 *
 * ```ts
 * const req = toRemoteRequest(QueryBuilder.from(Person).select(['name']));
 * const res = await fetch('/query', {method: 'POST', body: JSON.stringify(req)});
 * ```
 */
export function toRemoteRequest(qb: QueryBuilder): RemoteRequest {
  return {op: 'select', query: qb.toJSON()};
}

/** Wrap a create mutation IR in a {@link RemoteRequest} envelope. */
export function createRequest(query: CreateQuery): RemoteRequest {
  return {op: 'create', query};
}

/** Wrap an update mutation IR in a {@link RemoteRequest} envelope. */
export function updateRequest(query: UpdateQuery): RemoteRequest {
  return {op: 'update', query};
}

/** Wrap a delete mutation IR in a {@link RemoteRequest} envelope. */
export function deleteRequest(query: DeleteQuery): RemoteRequest {
  return {op: 'delete', query};
}
