---
summary: What remains of ASK after report 029 — the downstream half of the `op:'ask'` wire envelope (execution-gateway, server), so a remote peer answers the boolean itself rather than the local store doing it.
packages: [core]
---

# 036 — `ASK`: what remains

Report 029 shipped ask queries end to end inside `@_linked/core`: `AskBuilder`, `IRAskQuery`, the
`op: 'ask'` DSL-JSON envelope, `ASK WHERE { … }`, a required `IDataset.askQuery`, shapeless
existence via `Shape.exists(uri)`, and router fan-out for it. Type-free existence — the item this
backlog used to be mostly about — is done.

What is left is downstream of this package.

## The receiving side of `op: 'ask'`

`fromJSON` routes an `op: 'ask'` envelope to an `AskBuilder`, and `AskBuilder.exec()` resolves to a
boolean through the local dispatch — so a receiving process needs no new plumbing beyond what it
already does for select and mutation envelopes. But the gateway and server packages have to actually
handle the new kind:

| Package | Change |
|---|---|
| `execution-gateway` | accept `op: 'ask'`, return a boolean rather than a result set |
| `server` (`BackendAPIStoreProvider`) | implement `askQuery` by forwarding the ask envelope |

Until that lands, a remote store's `askQuery` has to answer some other way — there is no ask→select
rewrite in core to fall back on, by design (report 029).

**Ordering:** deploy receivers first. `assertWireVersion` only rejects on a *major* mismatch, so the
`1.0 → 1.1` bump gates nothing; what protects an old peer is `fromJSON` throwing `Unknown query op`,
which makes it fail loud rather than silently re-running the query as a select.

## Further ask questions

The envelope extends by *pattern*, not by flags — "is this node related to that one by this path"
is the same `op: 'ask'` with a different `where`. Nothing further is needed for those.

The one question that would **not** fit is SHACL conformance ("does this node validate against this
shape?"): it is not pattern-shaped, and should get its own `op` rather than be squeezed in here.
