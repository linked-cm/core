---
'@_linked/core': patch
---

Docs + internal cleanup, no public API or wire-format change:

- Add a copy-paste **LLM authoring prompt** for DSL-JSON
  (`documentation/dsl-json-llm-prompt.md`), referenced from the DSL-JSON spec —
  a self-contained system prompt (grammar + caveats + a `SHAPES` slot) for
  generating DSL-JSON queries from shape context.
- Rename the DSL-JSON expression codec and its wire types off an internal
  working codename: `DslJsonExpression` with `DslJson*` types. These are
  internal (not part of the export surface); the public `*JSON` types and
  `toJSON()` / `fromJSON()` are unchanged.
