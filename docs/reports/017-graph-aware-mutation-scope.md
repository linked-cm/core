---
summary: Scope SPARQL create/update/delete mutations to the configured named graph so writes target the same dataset graph as reads.
---

# 017 — Graph-Aware Mutation Scope

## Summary

SPARQL mutation generation now respects the configured graph in `SparqlOptions`.
When a store passes `graph`, generated create, update, delete, deleteAll,
deleteWhere, and updateWhere mutations wrap their write patterns in `GRAPH
<...>` blocks.

This aligns mutation behavior with graph-scoped reads. Before this fix, reads
could target a named graph while writes still landed in the default graph.

## Problem

Fuseki deployments commonly keep app data in a named graph and use
`default-graph-uri` for SELECT queries. That makes reads appear graph-scoped,
but SPARQL UPDATE requests do not inherit the SELECT default graph in the same
way.

The previous mutation serializer accepted `SparqlOptions.graph` in some call
paths but did not consistently propagate it into mutation algebra. As a result:

- `SELECT` could read from the configured app graph.
- `INSERT`/`DELETE` mutations could write against the unscoped/default graph.
- A write followed by a graph-scoped read could appear to have failed, or could
  leave stale triples in the named graph.

## Final Behavior

When `SparqlOptions.graph` is set, mutation SPARQL is graph-scoped.

Representative create shape:

```sparql
INSERT DATA {
  GRAPH <https://example.org/data> {
    <subject> a <Shape> .
    <subject> <property> "value" .
  }
}
```

Representative update/delete shape:

```sparql
DELETE {
  GRAPH <https://example.org/data> {
    ?s <p> ?old .
  }
}
INSERT {
  GRAPH <https://example.org/data> {
    ?s <p> ?new .
  }
}
WHERE {
  GRAPH <https://example.org/data> {
    ?s <p> ?old .
  }
}
```

When no graph is configured, generated mutation SPARQL remains graphless.

## Files Changed

| File | Responsibility |
|---|---|
| `src/sparql/irToAlgebra.ts` | Propagates `SparqlOptions.graph` through mutation algebra generation. |
| `src/sparql/algebraToString.ts` | Serializes graph-scoped mutation plans as `GRAPH <iri> { ... }` blocks. |
| `src/sparql/sparqlUtils.ts` | Shared graph wrapping helper used by mutation serialization. |
| `src/tests/sparql-mutation-golden.test.ts` | Golden coverage for graph-scoped and graphless mutation output. |
| `src/tests/sparql-fuseki-default-graph-investigation.test.ts` | Opt-in Fuseki investigation coverage documenting default-graph behavior. |

## Design Decisions

1. **Store-level graph option, not a new mutation DSL.** This fix uses the
   existing `SparqlOptions.graph` path so graph routing remains a store/runtime
   concern.

2. **Scope every mutation family consistently.** Create, update, delete,
   deleteAll, deleteWhere, and updateWhere all use the same configured graph
   when present.

3. **Do not change graphless output.** Existing consumers without a configured
   graph keep the same SPARQL shape.

4. **No app data migration.** The issue is query generation scope, not stored
   RDF shape.

## Test Coverage

- `src/tests/sparql-mutation-golden.test.ts`
  - graph-scoped create
  - graph-scoped update
  - graph-scoped delete/deleteAll
  - graph-scoped deleteWhere/updateWhere
  - graphless output remains unchanged
- `src/tests/sparql-fuseki-default-graph-investigation.test.ts`
  - opt-in behavioral investigation for Fuseki default graph semantics

## Compatibility

This is a patch behavior fix for configured graph stores. It should not affect
stores that do not pass `SparqlOptions.graph`.

Consumers that depended on configured graph writes leaking into the default graph
were relying on accidental behavior.
