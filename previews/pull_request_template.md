# Link a preview environment

A PR can start alone. After another related PR exists, add its full URL to
`pull_requests` in either PR's managed block, or reuse the first environment ID.
The coordinator validates membership and synchronizes the blocks automatically.
Use one PR per service. The URLs below are examples; replace them before use.

<!-- leia-preview-environment:start -->
```json
{
  "environment": "related-change",
  "isolation": "selective",
  "pull_requests": []
}
```
<!-- leia-preview-environment:end -->

Use `"isolation": "full"` when shared pre dependencies cannot support the test flow.
See the [data isolation and lifecycle contract](README.md).
