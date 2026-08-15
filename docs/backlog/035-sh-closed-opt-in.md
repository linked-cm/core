---
summary: Decide whether the undeclared-property check should honour `sh:closed` / `sh:ignoredProperties` per shape, as SHACL defines it, instead of rejecting unknown keys on every shape unconditionally.
packages: [core]
depends_on: [docs/reports/027-shape-validation-report.md]
---

# `sh:closed` as opt-in

## Status: idea — needs a decision before implementation

## Why

A mutation carrying a key the shape doesn't declare is rejected, always:

```
Invalid property key: slideNumber. The shape Slide does not have a registered property
with this name. Make sure the get/set method exists, and that it uses a @objectProperty
or @literalProperty decorator.
```

The validator reports this as `sh:ClosedConstraintComponent` (report 027), which is the right
component — but SHACL makes closedness **per shape**: a node shape is closed only when it declares
`sh:closed true`, and `sh:ignoredProperties` lists predicates permitted anyway. Both fields already
exist on `NodeShapeData` (`closed`, `ignoredProperties`) and are parsed; neither is read.

So the library is stricter than the vocabulary it implements, on a shape-by-shape basis it currently
ignores.

## The tension

This is not a straightforward correctness fix, which is why it is a decision and not a task.

- **For honouring the flag:** it is what `sh:closed` means. A shape that hasn't opted into closedness
  shouldn't reject data the way a closed one does, and a consumer who wants extra keys carried
  through has no way to say so today.
- **Against:** the unconditional check is a genuinely useful typo guard — `{titel: '…'}` fails loudly
  instead of silently writing nothing. Turning it off by default makes every unregistered key a
  silent no-op on any shape that hasn't set `sh:closed`, which is a worse default for the common
  case. Normalization also needs *some* answer: `convertNodeDescription` cannot build a field without
  a property shape, so an unknown key has to either throw or be dropped.

## Options

1. **Honour the flag literally.** Unknown keys are violations only on `sh:closed` shapes; elsewhere
   they are dropped. Most standards-correct, worst typo story.
2. **Honour the flag for severity, not for silence.** Unknown keys are always reported, but as
   `sh:Violation` on closed shapes and `sh:Warning` on open ones — so `conforms` stays true for an
   open shape while the report still names the key. Normalization drops the field. This needs the
   severity plumbing to actually distinguish the two, which the report type supports and nothing
   currently produces.
3. **Keep today's behaviour, document it as a deliberate divergence.** Cheapest; leaves
   `sh:closed`/`sh:ignoredProperties` parsed-but-unused.

Option 2 is the one worth prototyping: it keeps the typo guard visible without failing writes on
shapes that never asked to be closed, and it would make `sh:Warning` a real severity in the report
rather than a declared-but-unused one.

## Notes

- `sh:ignoredProperties` holds *predicate IRIs*, while the check operates on data *keys* (property
  labels). Whichever option is chosen needs to settle that mapping.
- Changing the default is a breaking change for anyone relying on the guard, so it wants a major or a
  clearly-flagged minor.
