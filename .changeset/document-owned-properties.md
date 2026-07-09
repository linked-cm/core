---
"@_linked/core": patch
---

docs: document **owned properties** in the README — a new "Owned properties (`contains` / `dependent`)" section under Shapes explaining exclusive-ownership object properties (`contains: true`) and the automatic cascade cleanup on update-replace, set-remove, and parent-delete, and how the property-level `contains` flag differs from the shape-level `dependent` flag. No code change.
