/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Wire protocol for {@link RemoteDataset}.
 *
 * A `RemoteRequest` is what travels over the wire to a remote endpoint. The
 * `select` op carries the lightweight DSL-JSON (`QueryBuilderJSON`) produced by
 * `QueryBuilder.toJSON()`; the receiving side lowers it to IR via
 * `QueryBuilder.fromJSON(json).build()`. Mutations carry the IR directly, since
 * the mutation builders do not (yet) have a `toJSON` serializer — see plan 001,
 * decision D1.
 */
import type {QueryBuilderJSON} from '../queries/QueryBuilder.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery} from '../queries/DeleteQuery.js';

export type RemoteRequest =
  | {op: 'select'; query: QueryBuilderJSON}
  | {op: 'create'; query: CreateQuery}
  | {op: 'update'; query: UpdateQuery}
  | {op: 'delete'; query: DeleteQuery};

export type RemoteResponse<T = unknown> =
  | {ok: true; result: T}
  | {ok: false; error: RemoteError};

export interface RemoteError {
  message: string;
  code: RemoteErrorCode;
}

export type RemoteErrorCode =
  /** `fromJSON`/`build` threw — bad payload or a shape/label not registered on the server. */
  | 'lowering_failed'
  /** The request `op` was not recognised. */
  | 'unsupported_op'
  /** The wrapped `IDataset` does not implement the optional handler for this op. */
  | 'handler_missing'
  /** The wrapped `IDataset` threw while executing the (already-lowered) query. */
  | 'execution_failed';

/** Build a failed {@link RemoteResponse} from an error code and an optional cause. */
export function fail(code: RemoteErrorCode, cause?: unknown): RemoteResponse<never> {
  const message =
    cause instanceof Error
      ? cause.message
      : cause === undefined || cause === null
        ? code
        : String(cause);
  return {ok: false, error: {message, code}};
}

/** Run `fn`, wrapping success in `{ok:true}` and any throw/rejection as `code`. */
export async function run<T>(
  code: RemoteErrorCode,
  fn: () => Promise<T>,
): Promise<RemoteResponse<T>> {
  try {
    return {ok: true, result: await fn()};
  } catch (err) {
    return fail(code, err);
  }
}
