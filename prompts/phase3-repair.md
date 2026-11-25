A quality gate failed after applying task {{TASK_ID}} ({{TASK_TITLE}}).
Fix ONLY the root cause of the failure without weakening tests, deleting assertions, disabling lint rules (`eslint-disable`, `@ts-ignore`), or bypassing checks.

## Failed Gate: {{GATE_NAME}} (`{{GATE_CMD}}`)
## Error Output (last 120 lines):
```text
{{ERROR_OUTPUT}}
```

## Current Git Diff:
```diff
{{GIT_DIFF}}
```

Apply the minimal fix to make the gate pass. Do NOT commit.
End with `<WQB_EXIT_SIGNAL status="DONE"/>` or `<WQB_EXIT_SIGNAL status="BLOCKED" reason="..."/>`.
