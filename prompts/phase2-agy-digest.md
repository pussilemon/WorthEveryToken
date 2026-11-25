Execute this single scoped coding task in the current directory. Be fast, minimal, and exact.

Task [{{TASK_ID}}]: {{TASK_TITLE}}
Target files: {{TARGET_FILES}}
Instructions: {{TASK_DESCRIPTION}}
Acceptance criteria:
{{ACCEPTANCE_CRITERIA}}

Rules:
- Modify ONLY the target files (and corresponding test files if adding tests).
- Do NOT run git commands.
- Do NOT output long explanations or full file dumps.

MANDATORY FINAL OUTPUT CONTRACT:
End your response with ONLY this compact digest block and nothing after it:
<WET_DIGEST>
{"files_changed": ["path1"], "summary": "1 sentence summary", "tests_added": 1, "risks": []}
</WET_DIGEST>
<WET_EXIT_SIGNAL status="DONE"/>
