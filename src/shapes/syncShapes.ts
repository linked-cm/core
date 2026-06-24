/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getAllShapeClasses} from '../utils/ShapeClass.js';
import {NodeShape, PropertyShape} from './SHACL.js';
import {DeleteBuilder} from '../queries/DeleteBuilder.js';
import {rdfList} from './List.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';

/**
 * The npm scope of framework shapes (NodeShape/PropertyShape/List/PathNode/Shape) that
 * describe the meta-model itself and must never be synced as user data. See plan-001 D4.
 */
const FRAMEWORK_PACKAGE = '@_linked/core';

/** Build the create-pipeline data object for a single PropertyShape (flattened under shapeIri). */
function buildPropertyShapeData(ps: PropertyShape, shapeIri: string): Record<string, unknown> {
  const psIri = `${shapeIri}/${ps.label}`;
  const d: Record<string, unknown> = {
    __id: psIri,
    path: serializePathToNodeData(ps.path, psIri),
  };
  if (ps.nodeKind) d.nodeKind = ps.nodeKind;
  if (ps.datatype) d.datatype = ps.datatype;
  if (typeof ps.minCount === 'number') d.minCount = ps.minCount;
  if (typeof ps.maxCount === 'number') d.maxCount = ps.maxCount;
  if (ps.name) d.name = ps.name;
  if (ps.description) d.description = ps.description;
  if (typeof ps.order === 'number') d.order = ps.order;
  if (ps.group) d.group = ps.group;
  if (ps.class) d.class = ps.class;
  if (ps.in) d.in = rdfList(ps.in, {base: `${psIri}/in`});
  if (ps.equalsConstraint) d.equals = ps.equalsConstraint;
  if (ps.disjoint) d.disjoint = ps.disjoint;
  if (ps.lessThan) d.lessThan = ps.lessThan;
  if (ps.lessThanOrEquals) d.lessThanOrEquals = ps.lessThanOrEquals;
  if (ps.hasValueConstraint !== undefined) d.hasValue = ps.hasValueConstraint;
  if (ps.valueShape) d.valueShape = ps.valueShape;
  if (ps.contains) d.contains = true;
  return d;
}

/** Build the create-pipeline data object for a NodeShape and its (flattened) property shapes. */
function buildNodeShapeData(nodeShape: NodeShape, shapeIri: string): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (nodeShape.targetClass) d.targetClass = nodeShape.targetClass;
  if (nodeShape.description) d.description = nodeShape.description;
  if (nodeShape.extends) d.extends = nodeShape.extends;
  if (nodeShape.dependent) d.dependent = true;
  const closed = (nodeShape as {closed?: boolean}).closed;
  if (closed !== undefined) d.closed = closed;
  // Flatten: emit own + inherited property shapes (deduped by label) under this shape.
  d.properties = nodeShape
    .getUniquePropertyShapes()
    .map((ps) => buildPropertyShapeData(ps, shapeIri));
  return d;
}

/**
 * Plan an idempotent sync of all code-registered (non-framework) NodeShapes into the store as
 * SHACL data — the forward (code → graph) materialization of arch-05 "code is canonical".
 *
 * Returns built-but-unexecuted thunks; the caller controls execution and batching:
 * ```ts
 * await Promise.all((await syncShapes()).map((run) => run()));
 * ```
 * Each in-code shape's thunk runs `delete → create` in order (the delete cascade-cleans the old
 * property shapes / list / path subtrees via the containment cascade, the create rebuilds them).
 * Shapes present in the store but no longer in code are deleted as orphans (their owned subtree
 * cascades too). Reads existing shape IRIs via the global query dispatch for orphan detection.
 */
export async function syncShapes(): Promise<Array<() => Promise<void>>> {
  // 1. Enumerate code-registered user shapes (exclude framework/meta shapes).
  const userShapes: Array<{iri: string; nodeShape: NodeShape}> = [];
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    if (!shapeClass?.shape) continue;
    const pkg = (shapeClass as {packageName?: string}).packageName;
    // Skip framework/meta shapes: the core package, and the base `Shape` which is registered
    // directly (no applyLinkedShape) and therefore carries no packageName.
    if (!pkg || pkg === FRAMEWORK_PACKAGE) continue;
    userShapes.push({iri, nodeShape: shapeClass.shape});
  }
  const localShapeIris = new Set(userShapes.map((s) => s.iri));

  // 2. Identity-read existing NodeShape IRIs (ids only) for orphan detection.
  const existingRows = (await (NodeShape as unknown as {
    select: () => Promise<Array<{id: string}>>;
  }).select()) as Array<{id: string}>;
  const existingShapeIris = new Set(existingRows.map((r) => r.id));

  const thunks: Array<() => Promise<void>> = [];

  // 3. Per in-code shape: delete (cascade) then recreate.
  for (const {iri, nodeShape} of userShapes) {
    const data = buildNodeShapeData(nodeShape, iri);
    thunks.push(() =>
      (DeleteBuilder.from(NodeShape, {id: iri}).exec() as Promise<unknown>)
        .then(() =>
          ((NodeShape.create(data as never).withId(iri) as unknown as {
            exec: () => Promise<unknown>;
          }).exec()),
        )
        .then(() => undefined),
    );
  }

  // 4. Orphan shapes (in store, not in code) → delete (cascade cleans their owned subtree).
  for (const iri of existingShapeIris) {
    if (!localShapeIris.has(iri)) {
      thunks.push(() =>
        (DeleteBuilder.from(NodeShape, {id: iri}).exec() as Promise<unknown>).then(
          () => undefined,
        ),
      );
    }
  }

  return thunks;
}
