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
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). The JSON always represents exactly what the user sees. Evaluation is gated separately by `isEvaluable()` (pure tree walk: all slots filled, no dangling operators).
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
- **`group.parens` is required and must be `'always'`.**
- **`isEvaluable` requires `op` to be in the known fn→symbol map** (add, subtract, multiply, divide, unaryMinus, unaryPlus, pow, mod) — unknown ops make a tree non-evaluable, rejected at conversion.

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

Implementation (`src/ast/vocabulary.ts`, `deriveDefaultUnits()`): keep every `math.Unit.UNITS` key as-is; for each unit's own prefix table, generate `prefix + symbol` candidates; keep a candidate only if `Unit.isValuelessUnit()` accepts it, so the list can never drift from what mathjs actually parses. Result: 251 base keys → 2770 entries (prefix×base candidates all accepted; long-name forms like `kilometer` included because mathjs accepts them). Interface shape unchanged — additive content only. Tests: prefixed spot-checks (`km`, `cm`, `mm`, `kg`, `kN`, `MPa`), `isValuelessUnit` on every entry, and a size-sanity band (between 4× and 30× the `UNITS` key count) that tolerates mathjs version drift but catches a broken derivation.

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

## Implementation status (2026-09-28)

AST core implemented: 10 node classes, toJSON/fromJSON + invariant validation, toMathNode fold, isEvaluable, vocabulary types + **prefix-aware** default static vocabulary (`deriveDefaultUnits()`, 2770 unit entries), toMathML throwing stub. 68 tests passing, incl. oracle fixtures evaluating identically to `math.parse(...).evaluate()` (hand-written literals in tests until editor output exists). pnpm pinned `10.34.5` via `packageManager` field.

Pre-npm note: hosts consuming Integral via a package `link:` each bundle their own mathjs copy alongside Integral's — unit instances are not `instanceof`-compatible across that boundary; hosts should duck-type units. Bundle-time dedup is a packaging concern for the npm switch.

## Open items

- Framework + version for the editor layer (signals vs. stores for caret state etc.) — must not block the AST core; the `./editor` subpath stays an empty placeholder until decided.
- NumberNode: `number` for v1; bignumber mode later = additive value-format flag, not structural.
- Subscript index-mode export policy (`x_n` as accessor) — when sequences exist.
- Nav-profile data schema details (vertical edges, empty-slot placeholders, selection) — when the editing engine is built.
