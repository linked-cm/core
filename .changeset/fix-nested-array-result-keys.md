---
"@_linked/core": patch
---

Preserve child property keys when lowering nested array selections. Queries such as `Action.select(action => ({image: action.image.select(image => [image.contentUrl])}))` now map the nested value to `image.contentUrl` instead of incorrectly returning it as `image.image`.
