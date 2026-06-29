/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Kind-detecting `fromJSON` — rehydrate any query DSL-JSON back into its builder.
 *
 * Mutation envelopes carry an `op` discriminator; select envelopes
 * (`QueryBuilderJSON`) do not. This is the inbound boundary helper: a receiving
 * process turns wire JSON into a live query with `fromJSON(json).exec()` (the
 * existing generic dispatch), no per-op routing needed.
 */
import {SelectBuilder, type QueryBuilderJSON} from './QueryBuilder.js';
import {CreateBuilder} from './CreateBuilder.js';
import {UpdateBuilder} from './UpdateBuilder.js';
import {DeleteBuilder} from './DeleteBuilder.js';
import type {MutationJSON} from './MutationSerialization.js';

/** Any query in its wire (DSL-JSON) form. */
export type QueryJSON = QueryBuilderJSON | MutationJSON;

export function fromJSON(
  json: QueryJSON,
): SelectBuilder | CreateBuilder | UpdateBuilder | DeleteBuilder {
  if (json && typeof json === 'object' && 'op' in json) {
    switch (json.op) {
      case 'create':
        return CreateBuilder.fromJSON(json);
      case 'update':
        return UpdateBuilder.fromJSON(json);
      case 'delete':
        return DeleteBuilder.fromJSON(json);
    }
  }
  return SelectBuilder.fromJSON(json as QueryBuilderJSON);
}
