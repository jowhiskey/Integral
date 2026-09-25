# AGENTS.md — Integral

> Generated 2026-09-25 (clean-repo restart). Integral is a standalone package; this file and docs/context must contain ZERO references to any consuming project.

## Project identity

**Integral** is a standalone, isomorphic, open-source WYSIWYG math editor npm package: direct AST manipulation, MathML Core rendering, math.js conversion, engineering features (units, constants, host-provided variable picker). Browser editor + Node-importable AST core in one package via subpath exports.

Current phase: **AST core implementation only** (node types, serialization, mathjs conversion, vocabulary interface, tests). Editor/caret/DOM layer is explicitly out of scope until the AST core and its contract tests are stable.

## Hard rules

1. **Zero consuming-project references** — not in file contents, not in commit messages, not in rationale. Negative references ("knows nothing about X") count as references.
2. **Never commit to `main`** — releases only. Work lands on `develop` via `feature/*` branches merged back.
3. **AST JSON format and the vocabulary interface are versioned contracts** (envelope `{ "v": 1, "root": … }`, additive-only changes; `fromJSON(toJSON(ast))` roundtrip stability guaranteed; type-tag meanings never change without a version bump).
4. **Subpath exports from day one**: AST/serialization/conversion entry point stays free of browser deps (server-importable); editor/DOM/caret entry point is browser-only.
5. **No editing methods on nodes** — nodes are dumb data; the editing engine applies ops as values and interprets nav profiles as data.
6. **Never route evaluation through `AST → string → math.parse()`.** `math.parse` only at string-import boundaries.
7. Integral never parses plain-text math as its input paradigm — live editing is key event → op → new tree. Plain-text input workflows belong to consuming projects.
8. **Implement the spec exactly; do not redesign.** If `docs/context/editor-spec.md` is ambiguous or seems wrong, stop and ask — never decide silently.

## Branching workflow

- `main` — releases only
- `develop` — integration branch
- `feature/*` — every piece of work, created from and pushed back to `develop`

## Routing table

| Area | Read first |
|---|---|
| Node set, invariants, JSON format, editing-layer principles, vocabulary | `docs/context/editor-spec.md` |

## Changelog

### 2026-09-25 — [workflow]
- ADDED: Clean-repo bootstrap. AGENTS.md + `docs/context/editor-spec.md` (full AST spec v1: node set, structural invariants, versioned JSON envelope, editing-layer principles, vocabulary interface, implementation phasing).
  Reason: fresh start for implementation; spec is the frozen contract the first commits implement against.
  Impact: current scope is the AST core only; `toMathML()` is a throwing stub; editor layer deferred.
