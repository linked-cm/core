---
"@_linked/core": patch
---

Lower multi-valued projected traversals into OPTIONAL (left-join) subtrees.

Report 014 fixed projection-only **singular** object traversals (`maxCount <= 1`)
to use nested `OPTIONAL` so a parent with a missing nested object is preserved.
That gate is now lifted: **multi-valued** projected traversals (e.g. a
`ShapeSet` like `knows`/`friends`/`pets`, with no `maxCount`) are lowered the
same way.

A query such as `Person.select(p => [p.givenName, p.knows.select(k => [k.givenName])])`
now returns every person — those with no `knows` get `knows: []` — instead of
inner-joining the parent away. The result grouper already collects multiple
child bindings into an array, so no mapping changes were needed.

Filtered (`.where(...)`) and otherwise-required traversals keep their existing
semantics, and paginated nested selects (inner `LIMIT`/`OFFSET`) are still
emitted as sub-SELECTs.
