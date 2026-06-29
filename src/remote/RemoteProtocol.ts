/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Wire protocol for {@link RemoteDataset}.
 *
 * A `RemoteRequest` is what travels over the wire to a remote endpoint. Every op
 * carries lightweight DSL-JSON: `select` carries `QueryBuilderJSON` (from
 * `QueryBuilder.toJSON()`), and create/update/delete carry the mutation builders'
 * `toJSON()` output. The receiving side lowers select via
 * `QueryBuilder.fromJSON(json).build()` and mutations via `lowerMutationJSON(json)`.
 */
import type {QueryBuilderJSON} from '../queries/QueryBuilder.js';
import type {
  CreateMutationJSON,
  UpdateMutationJSON,
  DeleteMutationJSON,
} from '../queries/MutationSerialization.js';

export type RemoteRequest =
  | {op: 'select'; query: QueryBuilderJSON}
  | CreateMutationJSON
  | UpdateMutationJSON
  | DeleteMutationJSON;

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
