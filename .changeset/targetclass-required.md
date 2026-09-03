---
'@_linked/core': minor
---

**Breaking: a shape must declare a `targetClass`.** A query or mutation on a shape with none —
on it or on any shape it extends — now throws instead of silently typing instances with the
shape's own IRI.

```ts
@linkedShape
class Person extends Shape {
  static targetClass = {id: 'https://example.org/Person'};  // required
}
```

`rdf:type` names the class a node **is**. The shape IRI identifies the SHACL description of that
class — a different node. Substituting one for the other conflated them, and did so invisibly:
every read and every write used the same substitution, so the data round-tripped and nothing ever
surfaced the mistake.

It also silently discarded a declared `targetClass` whose IRI was still temporary
(`linked://tmp/…`), typing those instances on the shape IRI instead. A temporary class IRI is now
honoured like any other — it is a real node whose IRI simply is not final yet.

`targetClass` is read off the shape class, so JavaScript static inheritance already walks the
superclass chain: a subclass that declares none inherits its parent's.

**A declared `sh:path` is likewise now always the predicate.** The same resolver skipped any path
whose IRI began `linked://tmp/` and substituted the property shape's own IRI. That skip existed only
so this repo's test fixtures could assert shape-derived predicates; it is gone, along with the
`linked://tmp/` special case itself. Two mutation code paths that built traversal predicates by
hand — bypassing the resolver entirely — now go through it, which fixes an expression-based update
(`p.bestFriend.name`) emitting the property shape IRI as its predicate.

**Migration.** Declare a `targetClass` on any shape that lacks one. Data written under the old
behaviour is typed with the shape IRI; either set that IRI as the shape's `targetClass` to keep
matching it, or retype the existing nodes. If any shape declared a `linked://tmp/` path, its
predicate changes from the property shape IRI to that declared path — no released code minted such
IRIs, so this is expected to affect nobody outside this repo's fixtures.
