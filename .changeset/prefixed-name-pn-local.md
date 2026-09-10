---
'@_linked/core': patch
---

Never emit a prefixed name whose local part is not a legal SPARQL `PN_LOCAL`.

`Prefix.toPrefixed()` guarded only against `/`, so when a registered namespace was a proper
string prefix of an IRI's own namespace the compaction produced names like
`create-now:access#PolicyRegistry`. `#` is not in `PN_LOCAL`: the tokenizer ends the name at
`create-now:access` and reads the rest of the line as a **comment**, eating the triple
terminator and yielding a query the store rejects — with a parse error pointing at the
*following* line, which is why this was hard to attribute.

The local part is now validated against a conservative `PN_LOCAL` allowlist and falls back to
`<full-iri>` when it does not fit. `collectPrefixes` asks `toPrefixed` rather than
re-implementing the rule, so the `PREFIX` block and the terms can never disagree.
