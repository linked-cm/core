/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `lower(query)` — turn a live query (builder) into its canonical IR algebra.
 *
 * This is the single, **free** lowering entry point. Keeping it out of the
 * builder classes is deliberate: the IR pipeline (`IRPipeline`/`IRMutation`) is
 * only reachable through `lower()` (and the mutation builders' internal
 * `_toIR()`), so a client that never lowers can tree-shake it away. The IR is an
 * implementation detail of stores that want it (e.g. SPARQL) — not the contract.
 */
import {buildSelectQuery} from './IRPipeline.js';
import type {IRSelectQuery} from './IntermediateRepresentation.js';
import type {IRCreateQuery} from './CreateQuery.js';
import type {IRUpdateQuery} from './UpdateQuery.js';
import type {IRDeleteQuery} from './DeleteQuery.js';

/** A select query that can be lowered (the select builder). */
export type LowerableSelect = {readonly __queryKind: 'select'; toRawInput(): any};
/** A mutation query that can be lowered (the mutation builders). */
export type LowerableCreate = {readonly __queryKind: 'create'; _toIR(): IRCreateQuery};
export type LowerableUpdate = {readonly __queryKind: 'update'; _toIR(): IRUpdateQuery};
export type LowerableDelete = {readonly __queryKind: 'delete'; _toIR(): IRDeleteQuery};
export type LowerableQuery =
  | LowerableSelect
  | LowerableCreate
  | LowerableUpdate
  | LowerableDelete;

export function lower(query: LowerableSelect): IRSelectQuery;
export function lower(query: LowerableCreate): IRCreateQuery;
export function lower(query: LowerableUpdate): IRUpdateQuery;
export function lower(query: LowerableDelete): IRDeleteQuery;
export function lower(
  query: LowerableQuery,
): IRSelectQuery | IRCreateQuery | IRUpdateQuery | IRDeleteQuery {
  if (query.__queryKind === 'select') {
    return buildSelectQuery(query.toRawInput());
  }
  // Mutation builders own their IR construction (factories live with them so the
  // select pipeline stays independent); `lower()` just invokes it.
  return query._toIR();
}
