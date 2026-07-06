# Contributing & Branch Workflow

Nothing lands on `main` directly. Changes are promoted through three stages:

```
feature/* ──PR──▶ dev ──PR──▶ qa ──PR──▶ main
                integrate     QA         release
```

1. **Feature branches** — branch off `dev`:
   `git checkout dev && git pull && git checkout -b feature/<name>`, then open a PR into `dev`.
2. **`dev`** — integration branch; all development merges here first. CI runs on every push/PR.
3. **`qa`** — promote `dev` → `qa` via PR, then run QA (manual/exploratory) on this branch.
4. **`main`** — release branch. Promote `qa` → `main` via PR only.

## CI (`.github/workflows/ci.yml`)
Runs on pushes to `dev`/`qa` and PRs into `qa`/`main`:
- Syntax check (`node --check`)
- Catalog + preset JSON validation (unique ids, valid types, preset items resolve)
- Smoke test: boots the server and checks core endpoints + the cross-origin (CSRF) guard

## Enforced on GitHub
- `main` and `qa` are protected: **pull request required**, **CI must be green**, direct pushes rejected.
- The repo default branch is `dev`, so new clones and PRs start from `dev`.
