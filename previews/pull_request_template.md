## Summary

Describe the change and its validation.

## Linked preview environment

For a change spanning multiple services, replace this example with the real PR URLs
and copy the identical block into every linked PR. Include this PR itself.
Each repository has its own PR numbers. Omitted backend services run their
`develop` commit inside the same isolated environment. An omitted Workbench
frontend continues to use the public stable pre frontend.

The deployment coordinator must be enabled before this block creates resources.
Remove this section when no linked environment is needed.

<!-- leia-preview-environment:start -->
```json
{
  "environment": "example-change",
  "pull_requests": [
    "https://github.com/leia-org/leia-designer-frontend/pull/123",
    "https://github.com/leia-org/leia-designer-backend/pull/456"
  ]
}
```
<!-- leia-preview-environment:end -->
