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
import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery} from './DeleteQuery.js';

/** A select query that can be lowered (the select builder). */
export type LowerableSelect = {readonly __queryKind: 'select'; toRawInput(): any};
/** A mutation query that can be lowered (the mutation builders). */
export type LowerableCreate = {readonly __queryKind: 'create'; _toIR(): CreateQuery};
export type LowerableUpdate = {readonly __queryKind: 'update'; _toIR(): UpdateQuery};
export type LowerableDelete = {readonly __queryKind: 'delete'; _toIR(): DeleteQuery};
export type LowerableQuery =
  | LowerableSelect
  | LowerableCreate
  | LowerableUpdate
  | LowerableDelete;

export function lower(query: LowerableSelect): SelectQuery;
export function lower(query: LowerableCreate): CreateQuery;
export function lower(query: LowerableUpdate): UpdateQuery;
export function lower(query: LowerableDelete): DeleteQuery;
export function lower(
  query: LowerableQuery,
): SelectQuery | CreateQuery | UpdateQuery | DeleteQuery {
  if (query.__queryKind === 'select') {
    return buildSelectQuery(query.toRawInput());
  }
  // Mutation builders own their IR construction (factories live with them so the
  // select pipeline stays independent); `lower()` just invokes it.
  return query._toIR();
}
