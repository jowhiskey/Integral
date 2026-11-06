# Integral — AGENTS.md

## What this is
**Integral** — a standalone, isomorphic WYSIWYG math editor package: direct AST manipulation, MathML Core rendering, math.js conversion, engineering features (units, constants, variable picker). Open source, MIT, will be published to npm once stable. Consumed by host applications as a package (pnpm `link:` to the sibling checkout pre-npm) — never vendored.

## Layout
```
src/ast/        # node classes, JSON envelope (versioned, additive-only), toMathNode fold, vocabulary
src/engine/     # editing engine (since 2026-11-06): ops as values, pure reducer, caret + nav profiles, undo — runtime-agnostic, no DOM
src/editor/     # (later) DOM layer: rendering, key handling — caret movement lives in src/engine — NOT plain-text input
docs/context/   # editor-spec.md — the frozen AST spec (read before touching node types)
```

## Hard rules
1. **Never edit `AGENTS.md` or `docs/context/*`.** These files are generated from the spec/knowledge base and synced from outside. Note warranted doc changes in your session report.
2. **Branching is tiered (2026-11-06).** Single-session, complete work goes **directly on `develop`** (trunk: no feature branch, no PR — commit only after the local suite is green, push only on the owner's explicit go). Multi-session or risky work goes on `feature/<name>` branches off `develop`, merged via one PR at completion. `main` is release-only; never commit to `main`.
3. **The AST JSON format and the vocabulary interface are versioned contracts — additive-only.** `fromJSON` must validate structural invariants.
4. **No plain-text input/REPL features here** — text parsing belongs to host applications; Integral is the live WYSIWYG editor only.
5. **No consuming-project references** in code, docs, commit messages, or rationale. Negative references count as references.
6. **Isomorphic**: no DOM APIs in `src/ast` — it must run in Node and the browser. DOM/MathML lives in the editor layer.
7. **Direct AST→mathjs fold** (`toMathNode()`), never strings — no `AST → string → math.parse` anywhere.
8. **Minimal code, maximal reuse.** Every added line of code is a potential future bug — before writing a new function/method, look for an existing pattern to reuse or extend; prefer simplifying and recycling over near-duplicates; delete code your change makes redundant.
9. **Retry budget — stop instead of looping.** No verification step (test suite, build, probe) gets more than two unchanged attempts: one rerun may rule out flakiness; a second identical failure signature is a STOP — never a third identical rerun. The same cap applies to fixes: two failed fix attempts on the same error with no progress = stop and report (in-session stop-and-ask, or the report's friction section). On the stop, report what failed, the failure signature, what was tried, and a diagnosis hypothesis — for mass-timeout / zero-assertion patterns, suspect the environment first (machine lock/throttle, orphaned processes, killed runs). Retries without new information burn tokens and context and prove nothing; stopping to report is always cheaper than looping.

## CI
CI exists since 2026-11-06: `.github/workflows/ci.yml`, PR-triggered plus a nightly scheduled run of `develop` (the `schedule:` trigger landed 2026-11-06 — cron 03:00 UTC; nothing runs on pushes, doc commits, or merges). Node 22; pnpm via the `packageManager` pin; `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm build`. "Green" for trunk work is the local suite (`pnpm test` + `pnpm build`/tsc), agent-verified, gating the `develop` push; the nightly run verifies `develop` after the fact. For feature-branch work the local suite is the in-session gate; PRs get the real run — check it at PR time (the coding session cannot observe runs; PRs are opened outside it). A red run for environmental reasons is a workflow fix on the same branch. Host applications exercise Integral through their own CI in addition.

## Working environment
- **Scratch files never leave the worktree.** Every transient file — commit-message files, one-shot scripts, probe output — lives at a repo-relative path inside the worktree (e.g. `.git/COMMIT_MSG` for `git commit -F`), deleted after use. Creating anything outside the worktree is banned outright (no `C:\tmp`, no `/tmp`, no `/c/...`, no drive-root paths, no home scratch). Why: the toolchain has two file writers with different path languages — Git Bash/MSYS maps `/tmp` to its own temp dir and `/c/tmp` to `C:\tmp`, while Windows-native file tools resolve `/tmp`/`/c/tmp` as literally-named folders against the current drive — so out-of-worktree scratch repeatedly lands at the drive root. Direct `node` execution of a scratch script importing repo TypeScript may additionally be blocked by the tool's approval layer; the sanctioned repro route is a temporary vitest file inside the worktree (deleted after use).

## Routing — read before touching
| Area | Read first |
|---|---|
| Anything AST-related (nodes, JSON, vocabulary, walker) | `docs/context/editor-spec.md` |
| Editing engine (ops, caret, movement, undo) | `docs/context/editor-spec.md` |

## History & docs feedback
- **Recent history:** `git log` — docs commits carry structured session records (what landed, why, impact, friction). Your session brief carries the current state; this file and `docs/context/*` carry the stable reference.
- **Docs feedback:** the docs are stable reference material; the code is ground truth. If any statement in `AGENTS.md` or `docs/context/*` contradicts what you find in the code, quote the doc line in your session report — never work around a wrong doc silently.
