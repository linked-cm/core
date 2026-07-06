import type {
  DesugaredExpressionWhere,
  DesugaredExistsWhere,
  DesugaredSelectQuery,
  PropertyPathSegment,
} from './IRDesugar.js';

export type CanonicalWhereExpression =
  | DesugaredExpressionWhere
  | DesugaredExistsWhere;

/** A canonicalized MINUS entry. */
export type CanonicalMinusEntry = {
  shapeId?: string;
  where?: CanonicalWhereExpression;
  propertyPaths?: PropertyPathSegment[][];
};

export type CanonicalDesugaredSelectQuery = Omit<DesugaredSelectQuery, 'where' | 'minusEntries'> & {
  where?: CanonicalWhereExpression;
  minusEntries?: CanonicalMinusEntry[];
};

/**
 * Normalizes a desugared select query into its canonical shape. The
 * where-clause is already canonical (`DesugaredWhere` === `CanonicalWhereExpression`),
 * so this only reshapes MINUS entries to the canonical field set; all other
 * fields pass through unchanged.
 */
export const canonicalizeDesugaredSelectQuery = (
  query: DesugaredSelectQuery,
): CanonicalDesugaredSelectQuery => {
  return {
    ...query,
    where: query.where,
    minusEntries: query.minusEntries?.map((entry) => ({
      shapeId: entry.shapeId,
      where: entry.where,
      propertyPaths: entry.propertyPaths,
    })),
  };
};
