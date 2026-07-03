# Paper Reader — Cursor agent notes

Agent instructions also live in `.cursorrules` (loaded automatically). This file captures workflow rules that are easy to grep.

## Before push

Run the full test suite and confirm it passes **before any `git push`**:

```bash
npm test
```

Do not push if any test fails. Fix or revert first, then re-run until green.
