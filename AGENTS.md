# Integral — AGENTS.md

## What this is
**Integral** — a standalone, isomorphic WYSIWYG math editor package: direct AST manipulation, MathML Core rendering, math.js conversion, engineering features (units, constants, variable picker). Open source, MIT, will be published to npm once stable. Consumed by host applications as a package (pnpm `link:` to the sibling checkout pre-npm) — never vendored.

## Layout
```
src/ast/        # node classes, JSON envelope (versioned, additive-only), toMathNode fold, vocabulary
src/editor/     # (later) caret navigation, MathML rendering, key handling — NOT plain-text input
docs/context/   # editor-spec.md — the frozen AST spec (read before touching node types)
```

## Hard rules
1. **Never edit `AGENTS.md` or `docs/context/*`.** These files are generated from the spec/knowledge base and synced from outside. Note warranted doc changes in your session report.
2. **Never commit to `develop` or `main`.** All work on `feature/<name>` branches off `develop`, merged via PR. `main` is release-only.
3. **The AST JSON format and the vocabulary interface are versioned contracts — additive-only.** `fromJSON` must validate structural invariants.
4. **No plain-text input/REPL features here** — text parsing belongs to host applications; Integral is the live WYSIWYG editor only.
5. **No consuming-project references** in code, docs, commit messages, or rationale. Negative references count as references.
6. **Isomorphic**: no DOM APIs in `src/ast` — it must run in Node and the browser. DOM/MathML lives in the editor layer.
7. **Direct AST→mathjs fold** (`toMathNode()`), never strings — no `AST → string → math.parse` anywhere.
8. **Minimal code, maximal reuse.** Every added line of code is a potential future bug — before writing a new function/method, look for an existing pattern to reuse or extend; prefer simplifying and recycling over near-duplicates; delete code your change makes redundant.

## CI
No CI yet (no `.github/workflows`) — "green" means the local suite (`pnpm test` + `pnpm build`/tsc), agent-verified; host applications exercise Integral through their own CI.

## Routing — read before touching
| Area | Read first |
|---|---|
| Anything AST-related (nodes, JSON, vocabulary, walker) | `docs/context/editor-spec.md` |

## History & docs feedback
- **Recent history:** `git log` — docs commits carry structured session records (what landed, why, impact, friction). Your session brief carries the current state; this file and `docs/context/*` carry the stable reference.
- **Docs feedback:** the docs are stable reference material; the code is ground truth. If any statement in `AGENTS.md` or `docs/context/*` contradicts what you find in the code, quote the doc line in your session report — never work around a wrong doc silently.
