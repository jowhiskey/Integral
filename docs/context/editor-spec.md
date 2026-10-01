# Integral — AST & Editor Spec (v1, frozen)

The exact AST structure Integral implements. Grew out of the original prototype design (2025, Johannes Weigl) + a MathML Core cross-check. This file is the frozen contract: the node set, structural invariants, JSON envelope, editing-layer principles, and vocabulary interface. **Versioned from commit one — later changes must be additive.**

## Design principle: visual wins, semantics are projected

The AST is shaped for the **visual/editorial** structure (WYSIWYG, MathML Core), not for mathjs's semantics. Semantics (evaluation, dependency analysis) are always *derived* via the deterministic projection `toMathNode()`. Consequences:

- Where mathjs has an operator but MathML has a dedicated element, the AST has a dedicated node: `frac`, `pow`, `root` (never `OperatorNode('/')`, `^`, or `FunctionNode('sqrt')`).
- Pure layout constructs (mspace, mphantom, mpadded) are never nodes — `toMathML()` injects them.
- Subscripts get a real node because visual engineering notation needs them (mathjs cannot express them at all).

## Node set (v1)

| Type | JSON `type` | Fields | `toMathNode()` projection |
|---|---|---|---|
| NumberNode | `num` | `value: number` | `ConstantNode` |
| SymbolNode | `sym` | `name: string` | `SymbolNode` |
| OperatorNode (n-ary) | `op` | `op` (mathjs fn name: add, subtract, multiply, unaryMinus, …), `args: Node[]` | `OperatorNode` |
| FunctionNode (n-ary) | `fn` | `name: string`, `args: Node[]` | `FunctionNode` |
| GroupNode | `group` | `child: Node` (exactly one), `parens: 'always'` (only value in v1; `'auto'`/`'none'` additive later) | `ParenthesisNode` |
| FractionNode | `frac` | `num`, `den` | `OperatorNode('/', divide, [a,b])` |
| PowerNode | `pow` | `base`, `exp` | `OperatorNode('^', pow, [a,b])` |
| RootNode | `root` | `radicand`, `index?` (omit when null = square root) | `FunctionNode('sqrt' \| 'nthRoot')` |
| SubscriptNode | `sub` | `base` (symbol name), `sub` (script) | flat `SymbolNode` (e.g. `x_max`) — label mode only in v1 |
| UnitNode | `unit` | `value: Node`, `unit: string` (mathjs unit syntax) | mathjs unit-bearing construct (projection frozen below) |

Deliberately **not** in v1: AssignmentNode (names live on the host's block concept — the AST is RHS-only), RelationalNode/ConditionalNode, MatrixNode/IndexNode/ArrayNode, BlockNode/ObjectNode/AccessorNode/FunctionAssignmentNode (probably never).

## Structural rules (contract invariants)

1. **GroupNode = order-of-operations marker, single child** — same purpose as mathjs's ParenthesisNode. Flat *visual* rows live in n-ary operator/function args, never in groups. A flat mixed token row inside a group is an **invalid state**; `fromJSON` rejects it.
2. **Precedence is structural, never derived.** `(5+4*3)/2` = frac(num: group(op[+](5, op[*](4,3))), den: 2). The AST never parses and never re-derives order of operations; projection is a pure relabel/fold.
3. **Same-op chains are flattened to n-ary** in the AST (`a+b+c` = one `op[+]` with 3 args) — **pure chains only**: a node's args may flatten only for the identical operator (`a+b+c` yes; `a+b-c` and `a*b/c` never share a node). Note: mathjs itself has *no* n-ary operator nodes (its parse tree is strictly binary left-associative; variadic only at function level like `add(a,b,c)`) — n-ary is our deliberate design, and flattening discards no association because flat chains encode none. The tree only encodes grouping the user actually expressed. Projection folds to mathjs's left-nested binaries (lossy-by-design; reconstruction goes through `fromJSON`, never through mathjs re-parse).
4. **Subscript name identity**: two symbols are the same name iff their `toMathNode()` SymbolNode names are equal. `sub(x, max)` ≡ typed `x_max` — one name for downstream consumers. Index semantics (`x_n` → accessor) deferred; export policy decided later, node shape unchanged.
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). The JSON always represents exactly what the user sees. Evaluation is gated separately by `isEvaluable()` (pure tree walk: all slots filled, no dangling operators). **`isEvaluable()` is structural, never semantic** (defined 2026-10-01): it answers completeness, not evaluation success — zero-arg and unknown-name functions are evaluable-but-throwing, because function existence/arity is a runtime concern of the evaluating scope (host-defined zero-arg functions are legal).
6. **Assignment never in the AST** — the host carries names on its own block concept; immutability/no-redefinition is a host concern.

## JSON format

- Envelope per formula blob (persisted by the host, one per formula): `{ "v": 1, "root": { …node } }`. Version on the envelope only, never per node.
- Short field names (machine-owned format; the TS class API is the human-readable layer).
- Per-node `type` discriminator; type-tag meanings never change without a version bump.
- No UIDs, no caret state in JSON. Caret = path into the tree (node + index), owned by the editing engine; UIDs (for click-to-caret, hover relations) are ephemeral, assigned at deserialization.
- Unknown extra fields are ignored on read (forward-compat for the additive-only contract).

### Encoding clarifications (decided 2026-09-25)

- **Empty slots:** `null` = empty slot (incomplete tree); **omitted = not applicable** (e.g. `root.index` omitted for square root — a complete tree). `toJSON` emits `null` for empty slots, omits not-applicable fields; `fromJSON` treats missing content slot and `null` identically. `isEvaluable()`: a slot is evaluable iff non-null node.
- **Empty formula:** envelope `{ "v": 1, "root": null }` (and omitted root) is legal JSON representing an entirely empty formula — isEvaluable false; toMathNode throws. Hosts persist formula containers on blur before first input; empty formulas need a representation.
- **Group flat-row rejection:** in v1 the only representable invalid shape is `child` as an array — `fromJSON` rejects arrays (child must be a single node object). Deeper structural prevention is the editing engine's job.
- **SubscriptNode fields:** `base` and `sub` are both strings in v1 (label mode). Index mode (structured scripts) = additive change with version bump if ever needed.
- **Empty-string semantics:** empty `sym.name`, `sub.base`/`sub.sub`, `unit.unit`, `fn.name` are legal (incomplete) JSON → isEvaluable false, toMathNode throws.
- **Unit-string validation (added 2026-09-30):** **non-empty** `unit.unit` must be a unit in the vocabulary's unit set — `fromJSON` rejects it otherwise, through the existing validation-error mechanism (same error shape as other invalid payloads). `fromJSON` takes an **optional vocabulary argument** (defaults to the default static vocabulary) so hosts with custom units validate against their own list; omission → default list applies. Empty `unit.unit` (`""`) is the explicit, deliberate exception — the legal incomplete state above, pinned by a test. Compound unit strings (`m/s`) reject — they cannot survive the frozen `SymbolNode` projection anyway.
- **`group.parens` is required and must be `'always'`.**
- **`isEvaluable` requires `op` to be in the known fn→symbol map** (add, subtract, multiply, divide, unaryMinus, unaryPlus, pow, mod) — unknown ops make a tree non-evaluable, rejected at conversion.

### Validation hardening (added 2026-10-01, fix session — decided adversarial-audit spec changes)

- **Non-finite numbers reject; `-0` normalizes.** `fromJSON` rejects NaN/±Infinity `num` values with a typed `ValidationError` ("must be a finite number") — `JSON.stringify` collapses them to `null`, so a non-finite envelope would become contract-invalid and unloadable after one persistence cycle. No JSON-safe encoding scheme. `-0` is normalized to `+0` at `fromJSON`: the sign is unrepresentable in JSON, and normalization is a fixed point of the persistence cycle (pinned).
- **Depth and node-count budgets, typed errors.** `fromJSON` enforces `AST_LIMITS = { maxDepth: 100, maxNodes: 500 }` (exported from `integral/ast`) via an **iterative pre-pass** that walks the envelope with an explicit stack *before* the recursive parse — the boundary can never stack-overflow on any input (1M-deep pinned); an args array longer than the whole node budget is rejected eagerly. Violations throw typed `ValidationLimitError { kind, limit }` (exported). Budget rationale (measured, Node 22 / mathjs 15.2): evaluation of a left-folded add chain crashes inside mathjs between 1500–2000 levels, so `maxNodes: 500` keeps ~3× margin; `maxDepth: 100` is generous for WYSIWYG math and far under `fromJSON`'s own crash point. Hosts building trees from text should import `AST_LIMITS` / `ValidationError` / `ValidationLimitError` and throw the same typed errors at their own seams. The enforced boundary is `fromJSON` — trees built via TS constructors directly bypass the budgets.
- **Subscript label rule.** Non-empty `sub.base` must be identifier-shaped (`^\p{L}[\p{L}\p{N}]*# Integral — AST & Editor Spec (v1, frozen)

The exact AST structure Integral implements. Grew out of the original prototype design (2025, Johannes Weigl) + a MathML Core cross-check. This file is the frozen contract: the node set, structural invariants, JSON envelope, editing-layer principles, and vocabulary interface. **Versioned from commit one — later changes must be additive.**

## Design principle: visual wins, semantics are projected

The AST is shaped for the **visual/editorial** structure (WYSIWYG, MathML Core), not for mathjs's semantics. Semantics (evaluation, dependency analysis) are always *derived* via the deterministic projection `toMathNode()`. Consequences:

- Where mathjs has an operator but MathML has a dedicated element, the AST has a dedicated node: `frac`, `pow`, `root` (never `OperatorNode('/')`, `^`, or `FunctionNode('sqrt')`).
- Pure layout constructs (mspace, mphantom, mpadded) are never nodes — `toMathML()` injects them.
- Subscripts get a real node because visual engineering notation needs them (mathjs cannot express them at all).

## Node set (v1)

| Type | JSON `type` | Fields | `toMathNode()` projection |
|---|---|---|---|
| NumberNode | `num` | `value: number` | `ConstantNode` |
| SymbolNode | `sym` | `name: string` | `SymbolNode` |
| OperatorNode (n-ary) | `op` | `op` (mathjs fn name: add, subtract, multiply, unaryMinus, …), `args: Node[]` | `OperatorNode` |
| FunctionNode (n-ary) | `fn` | `name: string`, `args: Node[]` | `FunctionNode` |
| GroupNode | `group` | `child: Node` (exactly one), `parens: 'always'` (only value in v1; `'auto'`/`'none'` additive later) | `ParenthesisNode` |
| FractionNode | `frac` | `num`, `den` | `OperatorNode('/', divide, [a,b])` |
| PowerNode | `pow` | `base`, `exp` | `OperatorNode('^', pow, [a,b])` |
| RootNode | `root` | `radicand`, `index?` (omit when null = square root) | `FunctionNode('sqrt' \| 'nthRoot')` |
| SubscriptNode | `sub` | `base` (symbol name), `sub` (script) | flat `SymbolNode` (e.g. `x_max`) — label mode only in v1 |
| UnitNode | `unit` | `value: Node`, `unit: string` (mathjs unit syntax) | mathjs unit-bearing construct (projection frozen below) |

Deliberately **not** in v1: AssignmentNode (names live on the host's block concept — the AST is RHS-only), RelationalNode/ConditionalNode, MatrixNode/IndexNode/ArrayNode, BlockNode/ObjectNode/AccessorNode/FunctionAssignmentNode (probably never).

## Structural rules (contract invariants)

1. **GroupNode = order-of-operations marker, single child** — same purpose as mathjs's ParenthesisNode. Flat *visual* rows live in n-ary operator/function args, never in groups. A flat mixed token row inside a group is an **invalid state**; `fromJSON` rejects it.
2. **Precedence is structural, never derived.** `(5+4*3)/2` = frac(num: group(op[+](5, op[*](4,3))), den: 2). The AST never parses and never re-derives order of operations; projection is a pure relabel/fold.
3. **Same-op chains are flattened to n-ary** in the AST (`a+b+c` = one `op[+]` with 3 args) — **pure chains only**: a node's args may flatten only for the identical operator (`a+b+c` yes; `a+b-c` and `a*b/c` never share a node). Note: mathjs itself has *no* n-ary operator nodes (its parse tree is strictly binary left-associative; variadic only at function level like `add(a,b,c)`) — n-ary is our deliberate design, and flattening discards no association because flat chains encode none. The tree only encodes grouping the user actually expressed. Projection folds to mathjs's left-nested binaries (lossy-by-design; reconstruction goes through `fromJSON`, never through mathjs re-parse).
4. **Subscript name identity**: two symbols are the same name iff their `toMathNode()` SymbolNode names are equal. `sub(x, max)` ≡ typed `x_max` — one name for downstream consumers. Index semantics (`x_n` → accessor) deferred; export policy decided later, node shape unchanged.
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). The JSON always represents exactly what the user sees. Evaluation is gated separately by `isEvaluable()` (pure tree walk: all slots filled, no dangling operators). **`isEvaluable()` is structural, never semantic** (defined 2026-10-01): it answers completeness, not evaluation success — zero-arg and unknown-name functions are evaluable-but-throwing, because function existence/arity is a runtime concern of the evaluating scope (host-defined zero-arg functions are legal).
6. **Assignment never in the AST** — the host carries names on its own block concept; immutability/no-redefinition is a host concern.

## JSON format

- Envelope per formula blob (persisted by the host, one per formula): `{ "v": 1, "root": { …node } }`. Version on the envelope only, never per node.
- Short field names (machine-owned format; the TS class API is the human-readable layer).
- Per-node `type` discriminator; type-tag meanings never change without a version bump.
- No UIDs, no caret state in JSON. Caret = path into the tree (node + index), owned by the editing engine; UIDs (for click-to-caret, hover relations) are ephemeral, assigned at deserialization.
- Unknown extra fields are ignored on read (forward-compat for the additive-only contract).

### Encoding clarifications (decided 2026-09-25)

- **Empty slots:** `null` = empty slot (incomplete tree); **omitted = not applicable** (e.g. `root.index` omitted for square root — a complete tree). `toJSON` emits `null` for empty slots, omits not-applicable fields; `fromJSON` treats missing content slot and `null` identically. `isEvaluable()`: a slot is evaluable iff non-null node.
- **Empty formula:** envelope `{ "v": 1, "root": null }` (and omitted root) is legal JSON representing an entirely empty formula — isEvaluable false; toMathNode throws. Hosts persist formula containers on blur before first input; empty formulas need a representation.
- **Group flat-row rejection:** in v1 the only representable invalid shape is `child` as an array — `fromJSON` rejects arrays (child must be a single node object). Deeper structural prevention is the editing engine's job.
- **SubscriptNode fields:** `base` and `sub` are both strings in v1 (label mode). Index mode (structured scripts) = additive change with version bump if ever needed.
- **Empty-string semantics:** empty `sym.name`, `sub.base`/`sub.sub`, `unit.unit`, `fn.name` are legal (incomplete) JSON → isEvaluable false, toMathNode throws.
- **Unit-string validation (added 2026-09-30):** **non-empty** `unit.unit` must be a unit in the vocabulary's unit set — `fromJSON` rejects it otherwise, through the existing validation-error mechanism (same error shape as other invalid payloads). `fromJSON` takes an **optional vocabulary argument** (defaults to the default static vocabulary) so hosts with custom units validate against their own list; omission → default list applies. Empty `unit.unit` (`""`) is the explicit, deliberate exception — the legal incomplete state above, pinned by a test. Compound unit strings (`m/s`) reject — they cannot survive the frozen `SymbolNode` projection anyway.
- **`group.parens` is required and must be `'always'`.**
, unicode-aware) and non-empty `sub.sub` must be `^[\p{L}\p{N}]+# Integral — AST & Editor Spec (v1, frozen)

The exact AST structure Integral implements. Grew out of the original prototype design (2025, Johannes Weigl) + a MathML Core cross-check. This file is the frozen contract: the node set, structural invariants, JSON envelope, editing-layer principles, and vocabulary interface. **Versioned from commit one — later changes must be additive.**

## Design principle: visual wins, semantics are projected

The AST is shaped for the **visual/editorial** structure (WYSIWYG, MathML Core), not for mathjs's semantics. Semantics (evaluation, dependency analysis) are always *derived* via the deterministic projection `toMathNode()`. Consequences:

- Where mathjs has an operator but MathML has a dedicated element, the AST has a dedicated node: `frac`, `pow`, `root` (never `OperatorNode('/')`, `^`, or `FunctionNode('sqrt')`).
- Pure layout constructs (mspace, mphantom, mpadded) are never nodes — `toMathML()` injects them.
- Subscripts get a real node because visual engineering notation needs them (mathjs cannot express them at all).

## Node set (v1)

| Type | JSON `type` | Fields | `toMathNode()` projection |
|---|---|---|---|
| NumberNode | `num` | `value: number` | `ConstantNode` |
| SymbolNode | `sym` | `name: string` | `SymbolNode` |
| OperatorNode (n-ary) | `op` | `op` (mathjs fn name: add, subtract, multiply, unaryMinus, …), `args: Node[]` | `OperatorNode` |
| FunctionNode (n-ary) | `fn` | `name: string`, `args: Node[]` | `FunctionNode` |
| GroupNode | `group` | `child: Node` (exactly one), `parens: 'always'` (only value in v1; `'auto'`/`'none'` additive later) | `ParenthesisNode` |
| FractionNode | `frac` | `num`, `den` | `OperatorNode('/', divide, [a,b])` |
| PowerNode | `pow` | `base`, `exp` | `OperatorNode('^', pow, [a,b])` |
| RootNode | `root` | `radicand`, `index?` (omit when null = square root) | `FunctionNode('sqrt' \| 'nthRoot')` |
| SubscriptNode | `sub` | `base` (symbol name), `sub` (script) | flat `SymbolNode` (e.g. `x_max`) — label mode only in v1 |
| UnitNode | `unit` | `value: Node`, `unit: string` (mathjs unit syntax) | mathjs unit-bearing construct (projection frozen below) |

Deliberately **not** in v1: AssignmentNode (names live on the host's block concept — the AST is RHS-only), RelationalNode/ConditionalNode, MatrixNode/IndexNode/ArrayNode, BlockNode/ObjectNode/AccessorNode/FunctionAssignmentNode (probably never).

## Structural rules (contract invariants)

1. **GroupNode = order-of-operations marker, single child** — same purpose as mathjs's ParenthesisNode. Flat *visual* rows live in n-ary operator/function args, never in groups. A flat mixed token row inside a group is an **invalid state**; `fromJSON` rejects it.
2. **Precedence is structural, never derived.** `(5+4*3)/2` = frac(num: group(op[+](5, op[*](4,3))), den: 2). The AST never parses and never re-derives order of operations; projection is a pure relabel/fold.
3. **Same-op chains are flattened to n-ary** in the AST (`a+b+c` = one `op[+]` with 3 args) — **pure chains only**: a node's args may flatten only for the identical operator (`a+b+c` yes; `a+b-c` and `a*b/c` never share a node). Note: mathjs itself has *no* n-ary operator nodes (its parse tree is strictly binary left-associative; variadic only at function level like `add(a,b,c)`) — n-ary is our deliberate design, and flattening discards no association because flat chains encode none. The tree only encodes grouping the user actually expressed. Projection folds to mathjs's left-nested binaries (lossy-by-design; reconstruction goes through `fromJSON`, never through mathjs re-parse).
4. **Subscript name identity**: two symbols are the same name iff their `toMathNode()` SymbolNode names are equal. `sub(x, max)` ≡ typed `x_max` — one name for downstream consumers. Index semantics (`x_n` → accessor) deferred; export policy decided later, node shape unchanged.
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). The JSON always represents exactly what the user sees. Evaluation is gated separately by `isEvaluable()` (pure tree walk: all slots filled, no dangling operators). **`isEvaluable()` is structural, never semantic** (defined 2026-10-01): it answers completeness, not evaluation success — zero-arg and unknown-name functions are evaluable-but-throwing, because function existence/arity is a runtime concern of the evaluating scope (host-defined zero-arg functions are legal).
6. **Assignment never in the AST** — the host carries names on its own block concept; immutability/no-redefinition is a host concern.

## JSON format

- Envelope per formula blob (persisted by the host, one per formula): `{ "v": 1, "root": { …node } }`. Version on the envelope only, never per node.
- Short field names (machine-owned format; the TS class API is the human-readable layer).
- Per-node `type` discriminator; type-tag meanings never change without a version bump.
- No UIDs, no caret state in JSON. Caret = path into the tree (node + index), owned by the editing engine; UIDs (for click-to-caret, hover relations) are ephemeral, assigned at deserialization.
- Unknown extra fields are ignored on read (forward-compat for the additive-only contract).

### Encoding clarifications (decided 2026-09-25)

- **Empty slots:** `null` = empty slot (incomplete tree); **omitted = not applicable** (e.g. `root.index` omitted for square root — a complete tree). `toJSON` emits `null` for empty slots, omits not-applicable fields; `fromJSON` treats missing content slot and `null` identically. `isEvaluable()`: a slot is evaluable iff non-null node.
- **Empty formula:** envelope `{ "v": 1, "root": null }` (and omitted root) is legal JSON representing an entirely empty formula — isEvaluable false; toMathNode throws. Hosts persist formula containers on blur before first input; empty formulas need a representation.
- **Group flat-row rejection:** in v1 the only representable invalid shape is `child` as an array — `fromJSON` rejects arrays (child must be a single node object). Deeper structural prevention is the editing engine's job.
- **SubscriptNode fields:** `base` and `sub` are both strings in v1 (label mode). Index mode (structured scripts) = additive change with version bump if ever needed.
- **Empty-string semantics:** empty `sym.name`, `sub.base`/`sub.sub`, `unit.unit`, `fn.name` are legal (incomplete) JSON → isEvaluable false, toMathNode throws.
- **Unit-string validation (added 2026-09-30):** **non-empty** `unit.unit` must be a unit in the vocabulary's unit set — `fromJSON` rejects it otherwise, through the existing validation-error mechanism (same error shape as other invalid payloads). `fromJSON` takes an **optional vocabulary argument** (defaults to the default static vocabulary) so hosts with custom units validate against their own list; omission → default list applies. Empty `unit.unit` (`""`) is the explicit, deliberate exception — the legal incomplete state above, pinned by a test. Compound unit strings (`m/s`) reject — they cannot survive the frozen `SymbolNode` projection anyway.
- **`group.parens` is required and must be `'always'`.**
 — both `_`-free; empty stays legal (incomplete state). This makes the `base_sub` projection **injective** (exactly one separator, unique split-back — pinned) and **display-stable** (the projected name re-parses as one mathjs symbol; hostile labels like `a+b` reject instead of display-reparsing as different trees). `sym.name` is untouched — the host's variable channel, outside this rule.
- **Arity rules.** `op pow` with more than 2 args rejects at `fromJSON` (2-arg pow stays legal and folds identically to `PowerNode`; incomplete `[x, null]` stays legal): mathjs parses `^` right-associatively while a flat n-ary chain encodes no association, so the ambiguous shape is rejected instead of legitimized. `unaryMinus`/`unaryPlus` must have exactly one arg.
- **Custom-vocabulary contract.** With a `vocabulary` passed to `fromJSON`, **omitted `units` = no units** — no silent fallback to the default list; hosts must pass their units explicitly. Entries are format-guarded up front: identifier shape + not parser-shadowed (compound strings like `m/s` reject at the vocabulary level). Unknown-but-well-formed strings are accepted on **host authority** — Integral cannot distinguish a host's `createUnit` unit from a made-up string (mathjs instances are not shared across packages pre-npm), so evaluation agreement for such strings is the host's `createUnit` responsibility (documented in `serialize.ts`).

## UnitNode toMathNode() — projection frozen (2026-09-25)

`math.parse('50 mm')` produces `OperatorNode('*', 'multiply', [ConstantNode(50), SymbolNode('mm')], implicit: true)`; the same construct hand-built evaluates to `Unit 50 mm`. **Frozen projection:** `UnitNode.toMathNode()` = `new OperatorNode('*', 'multiply', [value.toMathNode(), new SymbolNode(unit)], true)` — byte-identical to the parser's own output, no strings, no special Unit construct. `2 * (50 mm)` → `Unit 100 mm` on both sides.

## Vocabulary interface (second contract, alongside the JSON format)

Symbol classification (constant / unit / builtin / unknown-reference) is **not hardcoded into node classes** — a `SymbolNode`'s classification comes from a vocabulary provided by the host at use time. This is what makes Integral a general open-source editor: any host gets autocomplete, highlighting, and reference filtering through one mechanism.

Two layers, different lifecycles:

1. **Static vocabulary** — constants, units, built-in functions. Passed **once at editor init** (`init({ vocabulary })`), not per formula. Same instance config used by autocomplete, highlighting, and any host-side symbol filtering.
2. **Contextual vocabulary** — variable names for autocomplete/suggestions. Dynamic per context (provided by the host as a data lookup; e.g. only variables defined before the current line).

- **Integral ships defaults** for the static layer → works standalone with zero config; hosts override once. Adding a constant or unit (e.g. mathjs `createUnit()`) happens only in the host's config — Integral picks it up from the served vocabulary.
- **Discipline rule: data in, decisions stay in Integral.** Both vocabulary layers are plain data objects (lists of names, optionally display metadata; suggestion providers return data). The moment Integral accepts host *behavior*/callbacks with logic, it stops being an embeddable editor and becomes a framework. Data in — that's the line.

### Default units are prefix-aware (fixed 2026-09-28)

**Rule: the default `units` list is the *prefix-aware* mathjs set, derived programmatically from mathjs tables — never hand-maintained, never plain `Object.keys(math.Unit.UNITS)`.**

mathjs stores prefixed units as prefix × base, not as `UNITS` keys: `m`, `s`, `g` are keys, but `km`, `cm`, `mm`, `kg` are not. Hosts that classify symbols by exact membership against `vocabulary.units` therefore misclassify prefixed unit symbols as unknown references. This matters because mathjs does **not** absorb every unit symbol into a unit-bearing construct: in operator contexts like `5 km^2` (mathjs parses this as `5 * pow(km, 2)`), a bare unit symbol survives as a `SymbolNode` and classification falls to the vocabulary. A prefix-blind list makes `m^2` work while `km^2` is treated as an unknown name.

Implementation (`src/ast/vocabulary.ts`, `deriveDefaultUnits()`): keep every `math.Unit.UNITS` key as-is; for each unit's own prefix table, generate `prefix + symbol` candidates; keep a candidate only if `Unit.isValuelessUnit()` accepts it, so the list can never drift from what mathjs actually parses. Result: 251 base keys → 2770 entries (prefix×base candidates all accepted; long-name forms like `kilometer` included because mathjs accepts them); **2767 after the 2026-10-01 parser-shadow filter below**. Interface shape unchanged — additive content only. Tests: prefixed spot-checks (`km`, `cm`, `mm`, `kg`, `kN`, `MPa`), `isValuelessUnit` on every entry, and a size-sanity band (between 4× and 30× the `UNITS` key count) that tolerates mathjs version drift but catches a broken derivation.

**Parser-shadow filter (added 2026-10-01):** `deriveDefaultUnits()` drops candidates the mathjs namespace knows by name (`math[name] !== undefined`) — the expression parser resolves imports/functions before unit symbols, so a UnitNode carrying a shadowed name would pass validation and then throw at evaluation. Empirically exactly `chain`, `min`, `sec` drop (2770 → 2767 entries); the exhaustive sweep now passes with **no skip list**. Helpers `isUnitSymbolShape` / `isParserShadowed` are exported for the custom-vocabulary format guard.

## Isomorphism & subpath exports

- `toMathML()` / `toMathNode()` / `fromJSON()` are pure tree-walking code — they run in Node as well as the browser. Hosts evaluate server-side with the same conversion path as the browser.
- **Subpath exports from day one**: the AST/serialization/conversion entry point (`integral/ast`, server-importable) is separate from the editor/DOM/caret entry point (`integral/editor`, browser-only). Browser-only deps must stay out of the AST entry point.
- **The AST core (`./ast` subpath) is framework-free, permanently.** It's pure `(tree) → tree` code with no UI state. A framework in this layer would break the isomorphism: server-side evaluation would then require a UI framework in Node. The isomorphism is load-bearing, not stylistic. Embeddability is a feature for open-source adoption — usable from React/Vue/plain-JS hosts, not just one ecosystem.
- **Persistence note:** hosts persist the plain JSON envelope (`toJSON()` output), never object trees — serialization always strips behavior. Resurrection (JSON → live objects with methods) is Integral's `fromJSON()`, called by the host.

## Evaluation bridge

- **Direct AST→mathjs node objects, never strings.** Fold n-ary chains left-associatively into binary `OperatorNode`s (`op[+][1,2,3]` → `Op('+','add',[Op('+','add',[1,2]),3])`); `GroupNode(parens:'always')` → `ParenthesisNode`. The expression tree is derived, never stored — every evaluation folds fresh, nothing persists the folded shape. The only persisted form anywhere is the AST's own JSON.
- **`math.parse` has no place in Integral: Integral never parses text.** Text parsing (input boundaries, paste of external plain-text math) belongs to host applications. Rejected permanently: `AST → string → math.parse()` — string round-trips lose visual structure (FractionNode/RootNode), create a second source of truth, and move the `(5+3)*2` order-of-operations problem into production.

## Editing layer (decided principles, implementation later)

Not Day-1 scope, but decided so the AST never needs redesign:

- **Tree = dumb data; engine = all decisions.** Node classes carry structure + serialization + the conversions only. No editing methods on nodes.
- **Editing engine** (separate subpath, runtime-agnostic): applies **ops as values** (`Insert`, `DeleteAt`, `MoveCaret` as pure `(tree, op) → tree'`). Undo = op log; mergeable by hosts later; property-testable without DOM.
- **Per-type nav profiles as data** (registry, editor entry point only — keeps the isomorphic subpath clean): each node type declares its caret geography (slots, horizontal adjacency, exits, flows — e.g. fraction: numerator flows *down into* denominator, never sideways). Engine interprets profiles type-blind; adding a node type = adding a profile, never touching the engine.
- **Insertion policy decides structure once, at edit time.** The hard problem where the 2025 prototype stalled. A bounded precedence-aware attach algorithm: lower/equal precedence than context op → wrap context; higher → nest in right operand; user parens → new GroupNode. **Tested against `math.parse` output as oracle**: walking mathjs's parse tree vs. simulating typed insertion must yield identical ASTs. Operator-swap rules inherit the same oracle (typed-insertion vs. swap-edit of the same target expression must match).
- **Editing-session state stays local until blur**: the op log, undo, caret, and soft edit-lock are pure in-memory session state. Host persistence is touched once on blur; concurrent same-formula editing resolves at the host (last-writer-wins on the JSON blob is the host's documented default).
- **Operator-swap rules** (operator replacement on an n-ary chain): higher-precedence replacement → wrap the two adjacent operands (i, i+1) in the new node and splice back in place; lower-precedence replacement → split the chain at i: changed op becomes/joins the new lower-precedence parent, untouched same-op operands stay grouped among themselves — handles both left and right splits with no asymmetry. Edge rules: consecutive changed ops with equal precedence merge into one flat node; ÷ never flattens (treat ×↔÷ swap as parent-split with ÷ binary); precedence ties are where editors diverge from CAS expectations — property-test explicitly.
- **Structural nodes self-group; GroupNode is only for user-expressed parens.** FractionNode/PowerNode/RootNode slots are unambiguous — wrapping their contents in GroupNode would be redundant. `auto` groups are a *rendering* concern: they must never be written back into the stored tree.
- **No separate "semantic" format.** The AST already *is* the semantic structure (near-isomorphic to mathjs's parse tree); a second format would be a second source of truth and break op-log replay (ops address the AST by path). Caret/selection = per-user session state, not document state; derived data (rendering hints, cached MathML) stays out. Schema evolution = storage migration problem: budget a `migrate(json) → json` step in `fromJSON` from commit one.

## Adversarial audit — decided spec changes (2026-10-01; **implemented 2026-10-01, fix session — landed picks below**; branch `adversarial/ast` carried the 30 red findings, now fully ported into the real suites)

An adversarial audit of the AST layer (validation, round-trip, projection, vocabulary) produced findings that the owner has turned into decided spec changes. The fix session implements them and ports the red tests into the real suites.

1. **Non-finite numbers reject at `fromJSON` (decided).** NaN/±Infinity currently pass `fromJSON`/`toJSON` verbatim, but JSON cannot carry them: `JSON.stringify` collapses them to `null`, so a legitimately-constructed envelope becomes contract-invalid and unloadable after one persistence cycle (`-0` also loses its sign through the same cycle). **Decision: reject non-finite `num` values at the boundary — no JSON-safe encoding scheme.** The fix session picks and records the `-0` handling (normalize to `0`, or reject) within that boundary.
2. **Depth and node-count limits, as typed errors (decided).** A ~10k-deep envelope (~50 KB) currently kills `fromJSON` with an uncontrolled `RangeError` (stack overflow) — a crash, not a validation error; a 300k-arg n-ary `op` folds but its evaluation dies inside mathjs. **Decision: explicit depth and node-count budgets with typed validation errors at the boundary** — the layer must never emit trees its own evaluation engine cannot evaluate.
3. **`isEvaluable()` scope must be explicit (decided: define + document).** Today it is structural-only, but silently misreports: `fn(sqrt, [])` (zero args) and unknown function names report evaluable, then throw at evaluation. **Decision: the spec defines and documents the scope explicitly (structural vs semantic)** instead of leaving hosts to discover the gap at eval time.
4. **Subscript name-identity injectivity (decided boundary).** `sub(x_y, z)`, `sub(x, y_z)`, and `sym(x_y_z)` are three distinct stored trees that all project to one SymbolNode name — name forgery from untrusted input; unvalidated `sub` strings also project to names that display-reparse to different trees than they fold to. **Decision: forbid `_` in `base`/`sub` strings, or add a canonical encoding** — the fix session picks within that boundary (stop-and-ask if a third option emerges).
5. **N-ary `pow` association (decided: pick one, pin it).** N-ary `pow` currently folds left-associative while mathjs parses right-associative (`2^3^4` → `(2^3)^4` = 4096 vs `2^(3^4)` ≈ 2.4e24) — a 21-orders-of-magnitude divergence for an envelope that passes validation. **Decision: fold right-associative, or reject >2-arg `pow` chains at construction** — either is spec-conformant; the fix session picks and pins the choice with round-trip tests.
6. **Custom-vocabulary contract (decided).** The optional `vocabulary` parameter is currently a membership-only gate: any listed string passes as a "unit" and throws at evaluation ("Undefined symbol"), and omitting the `units` field silently falls back to the full 2770-entry default. **Decision: explicit `units`-omitted semantics + a format guard** on custom vocabulary entries (identifier-shape / valueless-unit-style check), so validation and evaluation agree.
7. **Vocabulary derivation must match the parser (decided).** `chain`, `min`, `sec` are derived as "units" but the mathjs expression parser resolves those strings as functions first — a UnitNode carrying them passes `fromJSON`, reports evaluable, and throws at evaluation (`TypeError: Unexpected type of argument`). **Decision: align the derivation with what the parser actually resolves** (filter or reclassify the shadowed entries).

**Exhaustion (no action needed):** the unit gate's completeness held under brute-force over all base units × all prefixes (16,566 candidates, zero accepted strings missing from the derived list) and soundness probes (non-units, prototype-key attacks) all reject correctly; `fromJSON(toJSON(ast))` is an exact fixed point for all finite, well-formed trees (empty slots, empty formula, `""`-unit, index-omission included). JSON structural rejection found no type-shape leaks beyond the count/depth/name-channel findings above.

**Landed picks (fix session, 2026-10-01, owner-ratified):** (1) `-0` normalized to `+0`; (2) budgets `maxDepth 100 / maxNodes 500`, iterative pre-pass, typed `ValidationLimitError`, limits + errors exported; (3) `isEvaluable` kept structural and documented — semantic gating is undecidable (hosts define functions with arbitrary arities, and zero-arg host functions are legal); (4) `_` forbidden in base/sub **plus an identifier-shape guard** (no canonical encoding — additive rejection only; the projection is injective and display-stable); (5) >2-arg `pow` rejected at `fromJSON` — right-folding would legitimize semantics no parser user can type, and a flat chain encodes no association, contradicting the flattening rationale; (6) omitted `units` = no units, format guard (identifier shape + not parser-shadowed), unknown well-formed strings accepted on host authority (indistinguishable from host `createUnit` units — mathjs instances aren't shared pre-npm); (7) parser-shadow filter via `math[name] !== undefined` (`chain`/`min`/`sec` drop). Plus one gap closure demanded by the red tests and ratified: **unary-arity validation** (`unaryMinus`/`unaryPlus` exactly one arg). All 30 red tests ported into the real suites, adapted to the decided semantics where the audit's expectations differed (each adaptation marked at the test site). Rules as implemented live in §Validation hardening above.

## Implementation status (2026-10-01)

AST core implemented: 10 node classes, toJSON/fromJSON + invariant validation (`src/ast/validation.ts`: `AST_LIMITS`, `ValidationError`, `ValidationLimitError` — depth/node budgets enforced by an iterative pre-pass; non-finite rejection + `-0` normalization; sub/pow/unary arity rules; custom-vocabulary format guard + explicit units-omitted semantics), toMathNode fold, isEvaluable (structural, documented — see §Structural rules 5), vocabulary types + **prefix-aware** default static vocabulary (`deriveDefaultUnits()`, 2767 unit entries after the parser-shadow filter), toMathML throwing stub. 167 tests passing across 10 files, incl. oracle fixtures evaluating identically to `math.parse(...).evaluate()` and all 30 adversarial-audit red tests ported into the real suites (validation / persistence / projection / evaluable / vocabulary). **This repo has no CI — verification = local `pnpm test` + `pnpm build` (tsc), stated per session.** pnpm pinned `10.34.5` via `packageManager` field.

Pre-npm note: hosts consuming Integral via a package `link:` each bundle their own mathjs copy alongside Integral's — unit instances are not `instanceof`-compatible across that boundary; hosts should duck-type units. Bundle-time dedup is a packaging concern for the npm switch.

## Open items

- Framework + version for the editor layer (signals vs. stores for caret state etc.) — must not block the AST core; the `./editor` subpath stays an empty placeholder until decided.
- NumberNode: `number` for v1; bignumber mode later = additive value-format flag, not structural.
- Subscript index-mode export policy (`x_n` as accessor) — when sequences exist.
- Nav-profile data schema details (vertical edges, empty-slot placeholders, selection) — when the editing engine is built.
