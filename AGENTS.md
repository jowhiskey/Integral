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

## CI
`pnpm test` on push; keep it green on every PR.

## Routing — read before touching
| Area | Read first |
|---|---|
| Anything AST-related (nodes, JSON, vocabulary, walker) | `docs/context/editor-spec.md` |

## Changelog

### 2026-10-01 — [spec]
- ADDED: `docs/context/editor-spec.md` — "Adversarial audit — decided spec changes" section: seven decided changes from the adversarial audit of the AST layer (branch `adversarial/ast`, 30 red findings, unmerged, findings-only). (1) reject non-finite `num` values at `fromJSON` (JSON.stringify collapses them to `null` — a legitimate envelope becomes contract-invalid after one persistence cycle; no JSON-safe encoding scheme); (2) explicit depth + node-count budgets as typed validation errors (a ~10k-deep envelope currently dies as an uncontrolled stack-overflow `RangeError`); (3) `isEvaluable()` scope defined + documented explicitly (today it silently reports zero-arg/unknown-name functions as evaluable); (4) subscript `_`-name-identity injectivity: forbid `_` in base/sub strings or add a canonical encoding (decided boundary; fix session picks); (5) n-ary `pow` association: right-fold or reject >2-arg chains (currently folds left while mathjs parses right — 4096 vs ≈2.4e24 for `2^3^4`); (6) custom-vocabulary contract: explicit `units`-omitted semantics + a format guard (membership-only gate today; omitted `units` silently falls back to the full 2770-entry default); (7) vocabulary derivation aligned with what the mathjs parser actually resolves (`chain`/`min`/`sec` currently pass validation as units, then throw at eval). Exhaustion notes included (unit-gate completeness brute-forced over 16,566 prefix×base candidates; round-trip is a fixed point for finite trees).
  Reason: the audit found the persisted-envelope contract can self-destruct (non-finite values), the validation boundary can crash instead of erroring (depth), and validation/evaluation disagree on several axes (evaluable scope, pow association, vocabulary membership).
  Impact: no code changes yet — the fix session implements the decided changes and ports the 30 red tests from `adversarial/ast` into the real suites. Contract changes are additive-only: rejections tighten validation; no stored-shape or interface changes.
### 2026-09-30 — [ast]
- CHANGED: `fromJSON` validates **non-empty** `UnitNode.unit` strings against the vocabulary unit set (default = the prefix-aware derived list, checked via a per-call `Set` — no second table) and rejects non-units through the existing validation-error mechanism. New **additive optional `vocabulary` parameter** on `fromJSON`: hosts with custom units validate against their own list; omitted → default static vocabulary. Empty `""` stays legal — documented incomplete-state exception, pinned by a test. Compound unit strings (`m/s`) now reject.
  Reason: `unit.unit` was shape-validated only — any string passed the parse boundary, and a consumer that resolves a shared name namespace (names vs. unit symbols) silently misread non-unit strings as units: wrong numbers, no error anywhere.
  Impact: tests 68 → 82 (rejections incl. nested args + error-message shape, base/prefixed accepts with `toJSON` round-trip, `""` exception pinned, custom-vocabulary accept-with/reject-without); all pre-existing fixtures unchanged (20 roundtrip incl. empty-unit case, 21 rejection cases); editor-spec.md §Encoding clarifications updated.

### 2026-09-28 — [architecture]
- CHANGED: `defaultStaticVocabulary.units` is now derived prefix-aware: base `math.Unit.UNITS` keys plus per-unit prefix×base candidates, kept only when `Unit.isValuelessUnit()` accepts them. 251 → 2770 entries; interface shape untouched (additive). Tests: prefixed spot-checks, isValuelessUnit on every entry, size-sanity band (4×–30× of UNITS key count).
  Reason: exact `UNITS` keys miss prefixed forms (`km`, `cm`, `mm`, `kg`, `kN`, `MPa`) — hosts filtering symbols by membership against the list misclassified prefixed unit symbols as unknown references.
  Impact: defaults are now the *prefix-aware* mathjs set (editor-spec.md §Vocabulary updated to say so); hosts may see newly classified unit symbols.

### 2026-09-26 — [workflow]
- ADDED: Hard rule 9 — the coding agent never edits `AGENTS.md` or `docs/context/*`; these files are generated from the knowledge base and synced from outside. Note warranted doc changes in the session report instead.
  Reason: the spec/knowledge base is the single source of truth; docs generation belongs to the owner-side sync workflow only.
  Impact: do not commit doc changes even alongside code work.

### 2026-09-25 — [workflow]
- ADDED: Clean-repo bootstrap. AGENTS.md + `docs/context/editor-spec.md` (full AST spec v1: node set, structural invariants, versioned JSON envelope, editing-layer principles, vocabulary interface, implementation phasing).
  Reason: fresh start for implementation; spec is the frozen contract the first commits implement against.
  Impact: current scope is the AST core only; `toMathML()` is a throwing stub; editor layer deferred.

### 2026-09-25 — [architecture] (second entry, same day)
- CHANGED: Empty formula is now representable: `{ "v": 1, "root": null }` (and omitted root) deserializes to null; toJSON(null) emits it; isEvaluable false. Two rejection tests removed, roundtrip test added (65/65).
  Reason: host persists blocks on blur before first input — empty formulas need a JSON representation.
  Impact: `fromJSON`/`toJSON` signatures are now `MathNode | null` at the envelope level; no change to non-empty trees or toMathNode.

### 2026-09-25 — [architecture]
- ADDED: AST core implemented (10 node classes, toJSON/fromJSON with envelope v1 + invariant validation, toMathNode fold, isEvaluable, vocabulary types + defaults, toMathML stub; 66 tests). UnitNode projection frozen (implicit-multiply OperatorNode); pnpm pinned 10.34.5 via packageManager.
  Reason: spec v1 frozen, first implementation slice.
  Impact: JSON contract now has a reference implementation; oracle fixtures are hand-written literals until editor output exists.
