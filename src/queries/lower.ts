/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `lower(query)` — turn a live query (builder) into its canonical IR algebra.
 *
 * This is the single, **free** lowering entry point, and the *only* place the
 * canonical-IR pipeline (`IRPipeline` / `IRMutation` / `IRLower` / …) is reached
 * from. The builders are deliberately IR-free: they hand `lower()` a plain
 * "lowering spec" (`mutationLowerSpec`) or raw select input, and all IR
 * construction happens here. A client that authors/serializes/forwards queries
 * but never calls `lower()` therefore tree-shakes the entire IR pipeline away.
 * The IR is an implementation detail of stores that want it (e.g. SPARQL) — not
 * the contract.
 */
import {buildSelectQuery} from './IRPipeline.js';
import {MutationQueryFactory} from './MutationQuery.js';
import {isSetModificationValue, type NodeDescriptionValue} from './QueryFactory.js';
import {PendingQueryContext} from './QueryContext.js';
import {resolveContextId} from './ContextRef.js';
import {
  buildCanonicalCreateMutationIR,
  buildCanonicalUpdateMutationIR,
  buildCanonicalUpdateWhereMutationIR,
  buildCanonicalDeleteMutationIR,
  buildCanonicalDeleteAllMutationIR,
  buildCanonicalDeleteWhereMutationIR,
} from './IRMutation.js';
import {toWhere} from './IRDesugar.js';
import {canonicalizeWhere} from './IRCanonicalize.js';
import {lowerWhereToIR} from './IRLower.js';
import type {WherePath} from './SelectQuery.js';
import type {IRSelectQuery} from './IntermediateRepresentation.js';
import type {IRCreateQuery} from './CreateQuery.js';
import type {IRUpdateQuery} from './UpdateQuery.js';
import type {IRDeleteQuery} from './DeleteQuery.js';
import type {
  CreateLowerSpec,
  UpdateLowerSpec,
  DeleteLowerSpec,
} from './mutationLowerSpec.js';

/** A select query that can be lowered (the select builder). */
export type LowerableSelect = {readonly __queryKind: 'select'; toRawInput(): any};
/** A mutation query that can be lowered (the mutation builders). */
export type LowerableCreate = {readonly __queryKind: 'create'; _lowerSpec(): CreateLowerSpec};
export type LowerableUpdate = {readonly __queryKind: 'update'; _lowerSpec(): UpdateLowerSpec};
export type LowerableDelete = {readonly __queryKind: 'delete'; _lowerSpec(): DeleteLowerSpec};
export type LowerableQuery =
  | LowerableSelect
  | LowerableCreate
  | LowerableUpdate
  | LowerableDelete;

/** Lower a pre-evaluated where path to its canonical IR fragment. */
function lowerWherePath(where: WherePath) {
  return lowerWhereToIR(canonicalizeWhere(toWhere(where)));
}

/**
 * Resolve any query-context reference carried as a mutation field value. The
 * builder preserves a live `PendingQueryContext` through normalization (so it can
 * serialize as `{$ctx}`); at lowering a mutation must hit a concrete node, so the
 * context is resolved here and an unset one throws `UnresolvedContextError`.
 */
function resolveValueContexts(val: unknown): unknown {
  if (val instanceof PendingQueryContext) {
    return {id: resolveContextId(val.contextName, true)!};
  }
  if (Array.isArray(val)) {
    return val.map(resolveValueContexts);
  }
  if (val && typeof val === 'object') {
    if (isSetModificationValue(val)) {
      const mod = val as {$add?: unknown[]; $remove?: unknown[]};
      const out: {$add?: unknown[]; $remove?: unknown[]} = {};
      if (mod.$add) out.$add = mod.$add.map(resolveValueContexts);
      if (mod.$remove) out.$remove = mod.$remove.map(resolveValueContexts);
      return out;
    }
    if ('fields' in val) {
      return resolveDescriptionContexts(val as NodeDescriptionValue);
    }
  }
  return val;
}

/** Deep-resolve context references in a normalized node description (returns a new copy). */
function resolveDescriptionContexts(desc: NodeDescriptionValue): NodeDescriptionValue {
  return {
    ...desc,
    fields: desc.fields.map((f) => ({...f, val: resolveValueContexts(f.val) as typeof f.val})),
  };
}

function lowerCreate(spec: CreateLowerSpec): IRCreateQuery {
  const description = resolveDescriptionContexts(
    new MutationQueryFactory().describe(spec.shapeClass.shape, spec.data, true),
  );
  return buildCanonicalCreateMutationIR({shape: spec.shapeClass.shape, description});
}

function lowerUpdate(spec: UpdateLowerSpec): IRUpdateQuery {
  const shape = spec.shapeClass.shape;
  const updates = resolveDescriptionContexts(
    new MutationQueryFactory().describe(shape, spec.data),
  );
  if (spec.mode === 'for') {
    return buildCanonicalUpdateMutationIR({id: spec.targetId!, shape, updates});
  }
  // forAll / where
  const lowered = spec.wherePath ? lowerWherePath(spec.wherePath) : undefined;
  return buildCanonicalUpdateWhereMutationIR({
    shape,
    updates,
    where: lowered?.where,
    wherePatterns: lowered?.wherePatterns,
  });
}

function lowerDelete(spec: DeleteLowerSpec): IRDeleteQuery {
  const shape = spec.shapeClass.shape;
  if (spec.mode === 'all') {
    return buildCanonicalDeleteAllMutationIR({shape});
  }
  if (spec.mode === 'where') {
    const {where, wherePatterns} = lowerWherePath(spec.wherePath!);
    return buildCanonicalDeleteWhereMutationIR({shape, where, wherePatterns});
  }
  const ids = new MutationQueryFactory().normalizeNodeRefs(spec.ids!);
  return buildCanonicalDeleteMutationIR({shape, ids});
}

export function lower(query: LowerableSelect): IRSelectQuery;
export function lower(query: LowerableCreate): IRCreateQuery;
export function lower(query: LowerableUpdate): IRUpdateQuery;
export function lower(query: LowerableDelete): IRDeleteQuery;
export function lower(
  query: LowerableQuery,
): IRSelectQuery | IRCreateQuery | IRUpdateQuery | IRDeleteQuery {
  switch (query.__queryKind) {
    case 'select':
      return buildSelectQuery(query.toRawInput());
    case 'create':
      return lowerCreate(query._lowerSpec());
    case 'update':
      return lowerUpdate(query._lowerSpec());
    case 'delete':
      return lowerDelete(query._lowerSpec());
  }
}
