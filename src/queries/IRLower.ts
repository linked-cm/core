import type {
  CanonicalDesugaredSelectQuery,
  CanonicalWhereExpression,
} from './IRCanonicalize.js';
import type {
  DesugaredExpressionSelect,
  DesugaredExpressionWhere,
  DesugaredExistsWhere,
  DesugaredSelection,
  DesugaredSelectionPath,
  DesugaredStep,
  DesugaredWhere,
} from './IRDesugar.js';
import {resolveExpressionRefs, ExistsCondition} from '../expressions/ExpressionNode.js';
import type {
  IRExpression,
  IRGraphPattern,
  IROrderByItem,
  IRProjectionItem,
  IRResultMapEntry,
  IRSelectQuery,
  IRShapeScanPattern,
  IRTraversePattern,
} from './IntermediateRepresentation.js';
import {canonicalizeWhere} from './IRCanonicalize.js';
import {lowerSelectionPathExpression, projectionKeyFromPath} from './IRProjection.js';
import {IRAliasScope} from './IRAliasScope.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';

/**
 * Creates a memoized traversal resolver that deduplicates (fromAlias, propertyShapeId)
 * pairs, generates unique aliases, and accumulates the resulting patterns.
 * Used by both select-query lowering and mutation expression resolution.
 */
export function createTraversalResolver<P>(
  generateAlias: () => string,
  createPattern: (from: string, to: string, property: string) => P,
): {resolve: (fromAlias: string, propertyShapeId: string) => string; patterns: P[]} {
  const patterns: P[] = [];
  const seen = new Map<string, string>();

  const resolve = (fromAlias: string, propertyShapeId: string): string => {
    const key = `${fromAlias}:${propertyShapeId}`;
    if (seen.has(key)) return seen.get(key)!;
    const toAlias = generateAlias();
    seen.set(key, toAlias);
    patterns.push(createPattern(fromAlias, toAlias, propertyShapeId));
    return toAlias;
  };

  return {resolve, patterns};
}

class LoweringContext {
  private counter = 0;
  private patterns: IRGraphPattern[] = [];
  private traverseMap = new Map<string, string>();
  private filterMap = new Map<string, IRExpression>();
  private innerPaginationMap = new Map<
    string,
    {limit?: number; offset?: number; orderBy?: import('./IntermediateRepresentation.js').IRInnerOrderBy[]}
  >();
  readonly rootAlias: string;

  constructor() {
    this.rootAlias = this.nextAlias();
  }

  private nextAlias(): string {
    return `a${this.counter++}`;
  }

  getOrCreateTraversal(fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number): string {
    const key = `${fromAlias}:${propertyShapeId}`;
    const existing = this.traverseMap.get(key);
    if (existing) return existing;

    const toAlias = this.nextAlias();
    const pattern: IRTraversePattern = {
      kind: 'traverse',
      from: fromAlias,
      to: toAlias,
      property: propertyShapeId,
    };
    if (pathExpr) {
      pattern.pathExpr = pathExpr;
    }
    if (typeof maxCount === 'number') {
      pattern.maxCount = maxCount;
    }
    this.patterns.push(pattern);
    this.traverseMap.set(key, toAlias);
    return toAlias;
  }

  generateAlias(): string {
    return this.nextAlias();
  }

  /**
   * Attaches an inline where filter to the traverse pattern targeting `toAlias`.
   * The filter will be merged into the pattern when `getPatterns()` is called.
   */
  attachFilter(toAlias: string, filter: IRExpression): void {
    this.filterMap.set(toAlias, filter);
  }

  /**
   * Attaches inner LIMIT/OFFSET/ORDER BY (from a nested select) to the traverse
   * pattern targeting `toAlias`. Merged into the pattern in `getPatterns()`.
   */
  attachInnerPagination(
    toAlias: string,
    pagination: {limit?: number; offset?: number; orderBy?: import('./IntermediateRepresentation.js').IRInnerOrderBy[]},
  ): void {
    this.innerPaginationMap.set(toAlias, pagination);
  }

  getPatterns(): IRGraphPattern[] {
    return this.patterns.map((p) => {
      if (p.kind !== 'traverse') return p;
      let pattern = p;
      if (this.filterMap.has(p.to)) {
        pattern = {...pattern, filter: this.filterMap.get(p.to)!};
      }
      const pagination = this.innerPaginationMap.get(p.to);
      if (pagination) {
        pattern = {
          ...pattern,
          ...(typeof pagination.limit === 'number' ? {innerLimit: pagination.limit} : {}),
          ...(typeof pagination.offset === 'number' ? {innerOffset: pagination.offset} : {}),
          ...(pagination.orderBy ? {innerOrderBy: pagination.orderBy} : {}),
        };
      }
      return pattern;
    });
  }
}

/** Minimal interface for alias generation used by lowerWhere and traversal resolvers. */
type AliasGenerator = {
  generateAlias(): string;
};

type PathLoweringOptions = {
  rootAlias: string;
  resolveTraversal: (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number) => string;
};

const lowerPath = (
  path: DesugaredSelectionPath,
  options: PathLoweringOptions,
): IRExpression => lowerSelectionPathExpression(path, options);

const lowerWhere = (
  where: CanonicalWhereExpression,
  ctx: AliasGenerator,
  options: PathLoweringOptions,
): IRExpression => {
  switch (where.kind) {
    case 'where_expression': {
      // ExpressionNode-based WHERE — resolve refs and return IRExpression directly
      const exprWhere = where as DesugaredExpressionWhere;
      return resolveExpressionRefs(
        exprWhere.expressionNode.ir,
        exprWhere.expressionNode._refs,
        options.rootAlias,
        options.resolveTraversal,
      );
    }
    case 'where_exists_condition': {
      // ExistsCondition-based WHERE (from .some()/.every()/.none())
      const existsWhere = where as DesugaredExistsWhere;
      return lowerExistsCondition(existsWhere.existsCondition, ctx, options);
    }
    default:
      const _exhaustive: never = where;
      throw new Error(`Unknown canonical where kind: ${(_exhaustive as {kind: string}).kind}`);
  }
};

/**
 * Lower an ExistsCondition to IRExistsExpression with proper traversal patterns.
 */
const lowerExistsCondition = (
  condition: ExistsCondition,
  ctx: AliasGenerator,
  options: PathLoweringOptions,
): IRExpression => {
  // Build traversal patterns for the collection path
  const {resolve: existsResolve, patterns: traversals} = createTraversalResolver(
    () => ctx.generateAlias(),
    (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
  );

  // Walk the path segments to create traversal patterns
  let currentAlias = options.rootAlias;
  for (const segmentId of condition.pathSegmentIds) {
    currentAlias = existsResolve(currentAlias, segmentId);
  }

  // Resolve the inner predicate's property refs against the EXISTS scope
  const filter = resolveExpressionRefs(
    condition.predicate.ir,
    condition.predicate._refs,
    currentAlias,
    existsResolve,
  );

  let existsExpr: IRExpression = {
    kind: 'exists_expr',
    pattern: traversals.length === 1
      ? traversals[0]
      : {kind: 'join', patterns: traversals},
    filter,
  };

  // Wrap in NOT if negated (.none() or outer NOT of .every())
  if (condition.negated) {
    existsExpr = {kind: 'not_expr', expression: existsExpr};
  }

  // Handle .and()/.or() chaining
  if (condition.chain.length > 0) {
    let result: IRExpression = existsExpr;
    for (const link of condition.chain) {
      let rightExpr: IRExpression;
      if (link.condition instanceof ExistsCondition) {
        rightExpr = lowerExistsCondition(link.condition, ctx, options);
      } else {
        rightExpr = resolveExpressionRefs(
          link.condition.ir,
          link.condition._refs,
          options.rootAlias,
          options.resolveTraversal,
        );
      }
      result = {
        kind: 'logical_expr',
        operator: link.op,
        expressions: [result, rightExpr],
      };
    }
    return result;
  }

  return existsExpr;
};

type ProjectionSeed =
  | {
      kind: 'path';
      path: DesugaredSelectionPath;
      key?: string;
      containerKey?: string;
    }
  | {
      kind: 'expression';
      expression: IRExpression;
      key: string;
      containerKey?: string;
    };

const combineWithParentPath = (
  parentPath: DesugaredStep[],
  path: DesugaredSelectionPath,
): DesugaredSelectionPath => ({
  kind: 'selection_path',
  steps: [...parentPath, ...path.steps],
});

const localName = (iri: string): string => {
  const hashIdx = iri.lastIndexOf('#');
  if (hashIdx >= 0) return iri.substring(hashIdx + 1);
  const slashIdx = iri.lastIndexOf('/');
  return slashIdx >= 0 ? iri.substring(slashIdx + 1) : iri;
};

/**
 * Lowers a canonical desugared select query into the final IRSelectQuery.
 * Introduces aliases, graph patterns (shape scans, traversals), and
 * converts selection paths and where-clauses into IR expressions.
 */
export const lowerSelectQuery = (
  canonical: CanonicalDesugaredSelectQuery,
): IRSelectQuery => {
  const ctx = new LoweringContext();
  const pathOptions: PathLoweringOptions = {
    rootAlias: ctx.rootAlias,
    resolveTraversal: (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number) =>
      ctx.getOrCreateTraversal(fromAlias, propertyShapeId, pathExpr, maxCount),
  };

  const root: IRShapeScanPattern = {
    kind: 'shape_scan',
    shape: canonical.shapeId || '',
    alias: ctx.rootAlias,
  };

  const aliasAfterPath = (steps: DesugaredStep[]): string => {
    let currentAlias = pathOptions.rootAlias;
    for (const step of steps) {
      if (step.kind === 'property_step') {
        currentAlias = pathOptions.resolveTraversal(currentAlias, step.propertyShapeId, step.pathExpr, step.maxCount);
      }
    }
    return currentAlias;
  };

  const collectProjectionSeeds = (
    selection: DesugaredSelection,
    key?: string,
    parentPath: DesugaredStep[] = [],
    containerKey?: string,
  ): ProjectionSeed[] => {
    if (selection.kind === 'selection_path') {
      return [{
        kind: 'path',
        path: combineWithParentPath(parentPath, selection),
        key,
        containerKey,
      }];
    }

    if (selection.kind === 'sub_select') {
      const combinedParentPath = [...parentPath, ...selection.parentPath];
      const nestedContainerKey = key || containerKey;
      // Nested-select inner LIMIT/OFFSET/ORDER BY → attach to the root→child
      // traverse (the alias reached by walking combinedParentPath). The serializer
      // wraps that traverse in a SPARQL sub-SELECT. Single-subject is enforced in
      // irToAlgebra; here we only record the intent.
      const hasInnerPagination =
        typeof selection.innerLimit === 'number' ||
        typeof selection.innerOffset === 'number' ||
        (selection.innerOrderBy && selection.innerOrderBy.length > 0);
      if (hasInnerPagination) {
        const childAlias = aliasAfterPath(combinedParentPath);
        ctx.attachInnerPagination(childAlias, {
          limit: selection.innerLimit,
          offset: selection.innerOffset,
          orderBy: selection.innerOrderBy?.map((o) => ({
            property: o.propertyShapeId,
            direction: o.direction,
          })),
        });
      }
      return collectProjectionSeeds(
        selection.selections,
        undefined,
        combinedParentPath,
        nestedContainerKey,
      );
    }

    if (selection.kind === 'custom_object_select') {
      return selection.entries.flatMap((entry) =>
        collectProjectionSeeds(entry.value, entry.key, parentPath, containerKey),
      );
    }

    if (selection.kind === 'multi_selection') {
      return selection.selections.flatMap((nestedSelection) =>
        collectProjectionSeeds(nestedSelection, key, parentPath, containerKey),
      );
    }



    if (selection.kind === 'expression_select') {
      const exprSelect = selection as DesugaredExpressionSelect;
      const resolved = resolveExpressionRefs(
        exprSelect.expressionNode.ir,
        exprSelect.expressionNode._refs,
        aliasAfterPath(parentPath),
        pathOptions.resolveTraversal,
      );
      return [{
        kind: 'expression',
        key: key || 'expr',
        expression: resolved,
        containerKey,
      }];
    }

    return [];
  };

  const projectionSeeds = canonical.selections.flatMap((selection) =>
    collectProjectionSeeds(selection),
  );

  const projectionScope = new IRAliasScope('projection');
  projectionScope.registerAlias(ctx.rootAlias, 'root');
  const projection: IRProjectionItem[] = [];
  const resultMapEntries: IRResultMapEntry[] = [];

  // Inline filter handler: when a property step has `.where()`, canonicalize
  // and lower the where predicate, then attach it to the traverse pattern.
  const inlineFilterHandler = (traverseAlias: string, where: DesugaredWhere) => {
    const canonical = canonicalizeWhere(where);
    const filterExpr = lowerWhere(canonical, ctx, {
      rootAlias: traverseAlias,
      resolveTraversal: pathOptions.resolveTraversal,
    });
    ctx.attachFilter(traverseAlias, filterExpr);
  };

  for (const seed of projectionSeeds) {
    const key = seed.kind === 'path'
      ? (seed.key || (
        seed.containerKey
          ? localName(projectionKeyFromPath(seed.path))
          : projectionKeyFromPath(seed.path)
      ))
      : seed.key;
    const alias = projectionScope.generateAlias(key).alias;
    projection.push({
      alias,
      expression: seed.kind === 'path'
        ? lowerSelectionPathExpression(seed.path, pathOptions, inlineFilterHandler)
        : seed.expression,
    });
    resultMapEntries.push({
      key,
      alias,
      ...(seed.containerKey ? {containerKey: seed.containerKey} : {}),
    });
  }

  const where = canonical.where ? lowerWhere(canonical.where, ctx, pathOptions) : undefined;

  const orderBy: IROrderByItem[] | undefined = canonical.sortBy
    ? canonical.sortBy.paths.map((path) => ({
        expression: lowerPath(path, pathOptions),
        direction: canonical.sortBy.direction,
      }))
    : undefined;

  // Lower MINUS entries → IRMinusPattern objects
  const minusPatterns: IRGraphPattern[] = [];
  if (canonical.minusEntries) {
    for (const entry of canonical.minusEntries) {
      if (entry.shapeId) {
        // Shape exclusion: MINUS { ?a0 a <Shape> }
        minusPatterns.push({
          kind: 'minus',
          pattern: {kind: 'shape_scan', shape: entry.shapeId, alias: ctx.rootAlias},
        });
      } else if (entry.propertyPaths && entry.propertyPaths.length > 0) {
        // Property existence exclusion: MINUS { ?a0 <prop1> ?m0 . ?a0 <prop2> ?m1 . }
        // Supports nested paths: ?a0 <bestFriend> ?m0 . ?m0 <name> ?m1 .
        const traversals: IRTraversePattern[] = [];
        for (const path of entry.propertyPaths) {
          let currentAlias = ctx.rootAlias;
          for (const segment of path) {
            const toAlias = ctx.generateAlias();
            traversals.push({
              kind: 'traverse',
              from: currentAlias,
              to: toAlias,
              property: segment.propertyShapeId,
            });
            currentAlias = toAlias;
          }
        }
        const innerPattern: IRGraphPattern = traversals.length === 1
          ? traversals[0]
          : {kind: 'join', patterns: traversals};
        minusPatterns.push({kind: 'minus', pattern: innerPattern});
      } else if (entry.where) {
        // Condition-based exclusion: MINUS { ?a0 <prop> ?val . FILTER(...) }
        const {resolve: minusResolveTraversal, patterns: minusTraversals} = createTraversalResolver(
          () => ctx.generateAlias(),
          (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
        );
        const minusOptions: PathLoweringOptions = {
          rootAlias: ctx.rootAlias,
          resolveTraversal: minusResolveTraversal,
        };
        const filter = lowerWhere(entry.where, ctx, minusOptions);
        const innerPattern: IRGraphPattern = minusTraversals.length === 1
          ? minusTraversals[0]
          : minusTraversals.length > 1
            ? {kind: 'join', patterns: minusTraversals}
            : {kind: 'shape_scan', shape: canonical.shapeId || '', alias: ctx.rootAlias};
        minusPatterns.push({kind: 'minus', pattern: innerPattern, filter});
      }
    }
  }

  return {
    kind: 'select',
    root,
    patterns: [...ctx.getPatterns(), ...minusPatterns],
    projection,
    where,
    orderBy,
    limit: canonical.limit,
    offset: canonical.offset,
    subjectId: canonical.subjectId,
    subjectIds: canonical.subjectIds,
    singleResult: canonical.singleResult,
    resultMap: resultMapEntries,
  };
};

/**
 * Standalone WHERE lowering — converts a CanonicalWhereExpression to IR expression + patterns.
 * Used by mutation builders (DeleteBuilder, UpdateBuilder) that don't go through the select pipeline.
 */
export const lowerWhereToIR = (
  where: CanonicalWhereExpression,
  rootAlias: string = 'a0',
): {where: IRExpression; wherePatterns: IRGraphPattern[]} => {
  let counter = 1; // start at 1 since a0 is the root
  const ctx: AliasGenerator = {
    generateAlias: () => `a${counter++}`,
  };

  const {resolve, patterns: traversals} = createTraversalResolver(
    () => ctx.generateAlias(),
    (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
  );

  const expr = lowerWhere(where, ctx, {rootAlias, resolveTraversal: resolve});
  return {where: expr, wherePatterns: traversals};
};
