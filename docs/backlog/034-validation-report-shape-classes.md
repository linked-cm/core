---
summary: Ship `ValidationReport` / `ValidationResult` as TS shape classes so a validation report can be persisted with an ordinary create query, instead of every consumer declaring the SHACL vocabulary itself.
packages: [core]
depends_on: [docs/reports/027-shape-validation-report.md]
---

# Validation report shape classes

## Status: idea

## Why

`validate()` returns a plain object that is already 1-1 with the SHACL vocabulary and materializable
as-is (report 027) — but only if the consumer declares shape classes for `sh:ValidationReport` and
`sh:ValidationResult` first. That is the same twenty lines in every project that wants to persist a
report, and every copy is a chance for the mapping to drift.

Shipping the classes in core makes persisting a report a one-liner:

```ts
const report = validate(Slide, extracted);
if (!report.conforms) await ValidationReport.create(report);
```

## What

Two shape classes, mirroring the mapping table in report 027:

```ts
@linkedShape
class ValidationResult extends Shape {
  static targetClass = shacl.ValidationResult;
  // focusNode, resultPath, value, sourceShape, sourceConstraintComponent,
  // resultSeverity  → linkedProperty, maxCount 1
  // resultMessage, propertyPath → literalProperty, xsd:string, maxCount 1
}

@linkedShape
class ValidationReport extends Shape {
  static targetClass = shacl.ValidationReport;
  // conforms → literalProperty, xsd:boolean, maxCount 1
  // results  → objectProperty, path shacl.result, shape ValidationResult
}
```

`src/tests/shape-validation-materialization.test.ts` already declares exactly these (as
`MaterializedValidationReport` / `MaterializedValidationResult`) and pushes a real report through a
create query, so the implementation is a move rather than a design exercise. That test should then
target the shipped classes instead of its local copies — keeping its guarantee that an undeclared key
fails the suite.

## Open questions

- **`contains` on `sh:result`?** Results have no independent existence — they belong to their report
  and should cascade-delete with it. The test models it as `contains: true`; confirm that is the
  intent before shipping, since it changes delete semantics.
- **`propertyPath`'s IRI.** The dotted label path is a non-SHACL extension. The test uses
  `https://linked.cm/ns/validation#propertyPath`; shipping the classes means committing to that IRI
  (or a core-ontology one) as public vocabulary.
- **Framework-shape handling.** These would be library-owned shapes, like `List` and `PathNode`.
  Check they land on the right side of the framework-shape skip in `syncShapes`.
- **Naming collision.** The exported class names would shadow the `ValidationReport` /
  `ValidationResult` *interfaces* already exported from `shapes/validation`. Either the interfaces or
  the classes need renaming (e.g. keep the data interfaces as the primary export and name the shapes
  `ValidationReportShape`), or the classes live behind a subpath export.
