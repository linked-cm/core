---
"@_linked/core": patch
---

Fixed 9 correctness bugs in query lowering and result mapping (nested sub-select filters, `.one()` truncation, `isNotDefined`/`defaultTo`/`Expr.ifThen` in `.where()`, nested aggregates, expression-over-traversal projections and updates). Most previously returned silently wrong results rather than errors. No public API changes — see `docs/reports/020-linked-query-test-coverage.md` for details.
