/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import * as Package from './utils/Package.js';
import * as LinkedErrorLogging from './utils/LinkedErrorLogging.js';
import * as LinkedFileStorage from './utils/LinkedFileStorage.js';
import * as LinkedStorage from './utils/LinkedStorage.js';
import * as CoreSet from './collections/CoreSet.js';
import * as CoreMap from './collections/CoreMap.js';
import * as Shape from './shapes/Shape.js';
import * as SHACLShapes from './shapes/SHACL.js';
import * as ShapeSet from './collections/ShapeSet.js';
import * as Prefix from './utils/Prefix.js';
import * as URI from './utils/URI.js';
import * as SelectQuery from './queries/SelectQuery.js';
import * as UpdateQuery from './queries/UpdateQuery.js';
import * as MutationQuery from './queries/MutationQuery.js';
import * as DeleteQuery from './queries/DeleteQuery.js';
import * as CreateQuery from './queries/CreateQuery.js';
import * as queryDispatch from './queries/queryDispatch.js';
import * as QueryFactory from './queries/QueryFactory.js';
import * as IntermediateRepresentation from './queries/IntermediateRepresentation.js';
import * as NameSpace from './utils/NameSpace.js';
import * as ShapeClass from './utils/ShapeClass.js';
import * as cached from './utils/cached.js';
import * as List from './shapes/List.js';
import * as PathNode from './shapes/PathNode.js';
export {syncShapes, syncShape} from './shapes/syncShapes.js';
export {rdfList} from './shapes/List.js';
export {serializePathToNodeData} from './shapes/serializePathToNodeData.js';
import * as ICoreIterable from './interfaces/ICoreIterable.js';
import * as IFileStore from './interfaces/IFileStore.js';
import * as IDataset from './interfaces/IDataset.js';
import * as rdf from './ontologies/rdf.js';
import * as rdfs from './ontologies/rdfs.js';
import * as xsd from './ontologies/xsd.js';
import * as shacl from './ontologies/shacl.js';
import * as coreOntology from './ontologies/linked-core.js';
import * as owl from './ontologies/owl.js';
import * as npm from './ontologies/npm.js';
import * as Sparql from './sparql/index.js';
import * as MutationSerializationModule from './queries/MutationSerialization.js';
import * as QueryBuilderModule from './queries/QueryBuilder.js';
import * as PropertyPathModule from './queries/PropertyPath.js';
import * as WhereConditionModule from './queries/WhereCondition.js';
import * as FieldSetModule from './queries/FieldSet.js';
import * as CreateBuilderModule from './queries/CreateBuilder.js';
import * as UpdateBuilderModule from './queries/UpdateBuilder.js';
import * as DeleteBuilderModule from './queries/DeleteBuilder.js';
// New dynamic query building API (Phase 2)
export {SelectBuilder, QueryBuilder} from './queries/QueryBuilder.js';
export {lower} from './queries/lower.js';
export type {LowerableQuery} from './queries/lower.js';
export {fromJSON} from './queries/fromJSON.js';
export type {QueryJSON} from './queries/fromJSON.js';
export {
  getQueryContext,
  setQueryContext,
  subscribeQueryContext,
  PendingQueryContext,
  UnresolvedContextError,
} from './queries/QueryContext.js';
export {
  CONTEXT_REF_KEY,
  encodeContextRef,
  isContextRefJSON,
  resolveContextId,
} from './queries/ContextRef.js';
export type {ContextRefJSON} from './queries/ContextRef.js';
export {PropertyPath, walkPropertyPath} from './queries/PropertyPath.js';
export type {WhereCondition, WhereOperator} from './queries/WhereCondition.js';

// Phase 3a — FieldSet
export {FieldSet} from './queries/FieldSet.js';
export type {FieldSetEntry, FieldSetInput, FieldSetJSON, FieldSetFieldJSON} from './queries/FieldSet.js';

// Phase 4 — Serialization types
export type {QueryBuilderJSON} from './queries/QueryBuilder.js';

// Phase 3b — Mutation builders
export {CreateBuilder} from './queries/CreateBuilder.js';
export {UpdateBuilder} from './queries/UpdateBuilder.js';
export {DeleteBuilder} from './queries/DeleteBuilder.js';

// Expressions — computed fields and functions
export {ExpressionNode} from './expressions/ExpressionNode.js';
export type {ExpressionInput, PropertyRefMap} from './expressions/ExpressionNode.js';
export {Expr} from './expressions/Expr.js';
export type {
  ExpressionUpdateProxy,
  ExpressionUpdateResult,
  BaseExpressionMethods,
  NumericExpressionMethods,
  StringExpressionMethods,
  DateExpressionMethods,
  BooleanExpressionMethods,
} from './expressions/ExpressionMethods.js';

// Phase 5 — Component query integration
export type {LinkedComponentInterface, QueryComponentLike} from './queries/SelectQuery.js';


// Mutation DSL-JSON serialization (create/update/delete to/from JSON)
export {
  encodeNodeData,
  encodeValue,
} from './queries/MutationSerialization.js';
export {
  decodeNodeData,
  lowerMutationJSON,
} from './queries/lowerMutationJSON.js';
export type {
  MutationJSON,
  CreateMutationJSON,
  UpdateMutationJSON,
  DeleteMutationJSON,
  MutationValueJSON,
  MutationFieldJSON,
  MutationNodeDataJSON,
} from './queries/MutationSerialization.js';

export function initModularApp() {
  let publicFiles = {
    Package,
    LinkedErrorLogging,
    LinkedFileStorage,
    LinkedStorage,
    CoreSet,
    CoreMap,
    Shape,
    ShapeSet,
    Prefix,
    NameSpace,
    cached,
    URI,
    ShapeClass,
    List,
    PathNode,
    ICoreIterable,
    IFileStore,
    IDataset,
    SelectQuery,
    UpdateQuery,
    MutationQuery,
    DeleteQuery,
    CreateQuery,
    queryDispatch,
    QueryFactory,
    IntermediateRepresentation,
    SHACLShapes,
    rdf,
    rdfs,
    xsd,
    shacl,
    coreOntology,
    owl,
    npm,
    Sparql,
    MutationSerializationModule,
    QueryBuilderModule,
    PropertyPathModule,
    WhereConditionModule,
    FieldSetModule,
    CreateBuilderModule,
    UpdateBuilderModule,
    DeleteBuilderModule,
  };
  var lincdExport = {};
  for (let fileKey in publicFiles) {
    let exportedClasses = publicFiles[fileKey];
    for (let className in exportedClasses) {
      lincdExport[className] = exportedClasses[className];
    }
  }
  if (typeof window !== 'undefined') {
    Object.assign(window['_linked'], lincdExport);
  } else if (typeof global !== 'undefined') {
    Object.assign(global['_linked'], lincdExport);
  }
}
