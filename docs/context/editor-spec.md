# Integral â AST & Editor Spec (v1, frozen)

The exact AST structure Integral implements. Grew out of the original prototype design (2025, Johannes Weigl) + a MathML Core cross-check. This file is the frozen contract: the node set, structural invariants, JSON envelope, editing-layer principles, and vocabulary interface. **Versioned from commit one â later changes must be additive.**

## Design principle: visual wins, semantics are projected

The AST is shaped for the **visual/editorial** structure (WYSIWYG, MathML Core), not for mathjs's semantics. Semantics (evaluation, dependency analysis) are always *derived* via the deterministic projection `toMathNode()`. Consequences:

- Where mathjs has an operator but MathML has a dedicated element, the AST has a dedicated node: `frac`, `pow`, `root` (never `OperatorNode('/')`, `^`, or `FunctionNode('sqrt')`).
- Pure layout constructs (mspace, mphantom, mpadded) are never nodes â `toMathML()` injects them.
- Subscripts get a real node because visual engineering notation needs them (mathjs cannot express them at all).

## Node set (v1)

| Type | JSON `type` | Fields | `toMathNode()` projection |
|---|---|---|---|
| NumberNode | `num` | `value: number` | `ConstantNode` |
| SymbolNode | `sym` | `name: string` | `SymbolNode` |
| OperatorNode (n-ary) | `op` | `op` (mathjs fn name: add, subtract, multiply, unaryMinus, â¦), `args: Node[]` | `OperatorNode` |
| FunctionNode (n-ary) | `fn` | `name: string`, `args: Node[]` | `FunctionNode` |
| GroupNode | `group` | `child: Node` (exactly one), `parens: 'always'` (only value in v1; `'auto'`/`'none'` additive later) | `ParenthesisNode` |
| FractionNode | `frac` | `num`, `den` | `OperatorNode('/', divide, [a,b])` |
| PowerNode | `pow` | `base`, `exp` | `OperatorNode('^', pow, [a,b])` |
| RootNode | `root` | `radicand`, `index?` (omit when null = square root) | `FunctionNode('sqrt' | 'nthRoot')` |
| SubscriptNode | `sub` | `base` (symbol name), `sub` (script) | flat `SymbolNode` (e.g. `x_max`) â label mode only in v1 |
| UnitNode | `unit` | `value: Node`, `unit: string` (mathjs unit syntax) | mathjs unit-bearing construct (projection frozen, below) |

Deliberately **not** in v1: AssignmentNode (names live on the host's block concept, not in the formula tree â the AST is RHS-only), RelationalNode/ConditionalNode, MatrixNode/IndexNode/ArrayNode, BlockNode/ObjectNode/AccessorNode/FunctionAssignmentNode (probably never).

## Structural rules (contract invariants)

1. **GroupNode = order-of-operations marker, single child** â same purpose as mathjs's ParenthesisNode. Flat *visual* rows live in n-ary operator/function args, never in groups. A flat mixed token row inside a group is an **invalid state**; `fromJSON` must reject it.
2. **Precedence is structural, never derived.** `(5+4*3)/2` = frac(num: group(op[+](5, op[+](4,3))), den: 2). The AST never parses and never re-derives order of operations; projection is a pure relabel/fold.
3. **Same-op chains are flattened to n-ary** in the AST (`a+b+c` = one `op[+]` with 3 args) â **pure chains only**: a node's args may flatten only for the identical operator (`a+b+c` yes; `a+b-c` and `a*b/c` never share a node). Note: mathjs itself has *no* n-ary operator nodes (its parse tree is strictly binary left-associative; variadic only at function level like `add(a,b,c)`) â n-ary is our deliberate design, and flattening discards no association because flat chains encode none. The tree only encodes grouping the user actually expressed. Projection folds to mathjs's left-nested binaries (lossy-by-design; reconstruction goes through `fromJSON`, never through mathjs re-parse).
4. **Subscript name identity**: two symbols are the same name iff their `toMathNode()` SymbolNode names are equal. `sub(x, max)` â¡ typed `x_max` â one name for downstream consumers. Index semantics (`x_n` â accessor) deferred; export policy decided later, node shape unchanged.
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). Hosts persist formulas on blur regardless of completeness. Evaluation is gated separately by `isEvaluable()` (pure tree walk: all slots filled, no dangling operators). The JSON always represents exactly what the user sees.
6. **Assignment never in the AST** â the host carries names on its blocks; immutability/no-redefinition is a host concern.

## JSON format

- Envelope per formula blob (persisted by the host, one per formula): `{ "v": 1, "root": { â¦node } }`. Version on the envelope only, never per node.
- Short field names (machine-owned format; the TS class API is the human-readable layer).
- Per-node `type` discriminator; type-tag meanings never change without a version bump.
- No UIDs, no caret state in JSON. Caret = path into the tree (node + index), owned by the editing engine; UIDs (for click-to-caret, hover relations) are ephemeral, assigned at deserialization.
- Unknown extra fields are ignored on read (forward-compat for the additive-only contract).

### Encoding clarifications (decided 2026-09-25)

- **Empty slots:** `null` = empty slot (incomplete tree); **omitted = not applicable** (e.g. `root.index` omitted for square root â a complete tree). `toJSON` emits `null` for empty slots, omits not-applicable fields; `fromJSON` treats missing content slot and `null` identically. `isEvaluable()`: a slot is evaluable iff non-null node.
- **Empty formula:** envelope `{ "v": 1, "root": null }` (and omitted root) is legal JSON representing an entirely empty formula â isEvaluable false; toMathNode throws. Hosts persist formula containers on blur before first input.
- **Group flat-row rejection:** in v1 the only representable invalid shape is `child` as an array â `fromJSON` rejects arrays (child must be a single node object). Deeper structural prevention is the editing engine's job.
- **SubscriptNode fields:** `base` and `sub` are both strings in v1 (label mode). Index mode (structured scripts) = additive change with version bump if ever needed.
- **Empty-string semantics:** empty `sym.name`, `sub.base`/`sub.sub`, `unit.unit`, `fn.name` are legal (incomplete) JSON â isEvaluable false, toMathNode throws.
- **`group.parens` is required and must be `'always'`***
- **`isEvaluable` requires `op` to be in the known fnâsymbol map** (add, subtract, multiply, divide, unaryMinus, unaryPlus, pow, mod) â unknown ops make a tree non-evaluable, rejected at conversion.

## UnitNode toMathNode() â projection frozen

`math.parse('50 mm')` produces `OperatorNode('*', 'multiply', [ConstantNode(50), SymbolNode('mm')], implicit: true)`; the same construct hand-built evaluates to `Unit 50 mm`. **Frozen projection:** `UnitNode.toMathNode()` = `new OperatorNode('*', 'multiply', [value.toMathNode(), new SymbolNode(unit)], true)` â byte-identical to the parser's own output, no strings, no special Unit construct. `2 * (50 mm)` â `Unit 100 mm` on both sides.

## Vocabulary interface (second contract, alongside the JSON format)

Symbol classification (constant / unit / builtin / unknown-reference) is **not hardcoded into node classes** â a `SymbolNode`'s classification comes from a vocabulary provided by the host at use time. This is what makes Integral a general open-source editor: any host gets autocomplete, highlighting, and reference filtering through one mechanism.

Two layers, different lifecycles:

1. **Static vocabulary** â constants, units, built-in functions. Passed **once at editor init** (`init({ vocabulary })`), not per formula. Same instance config used by autocomplete, highlighting, and any host-side symbol filtering.
2. **Contextual vocabulary** â variable names for autocomplete/suggestions. Dynamic per context (provided by the host as a data lookup; e.g. only variables defined before the current line).

- **Integral ships defaults** for the static layer â works standalone with zero config; hosts override once. Adding a constant or unit (e.g. mathjs `createUnit()`) happens in the host's config â Integral picks it up from the served vocabulary.
- **Discipline rule: data in, decisions stay in Integral.** Both vocabulary layers are plain data objects (lists of names, optionally display metadata; suggestion providers return data). The moment Integral accepts host *behavior*/callbacks with logic, it stops being an embeddable editor and becomes a framework. Data in â that's the line.

### Default units are prefix-aware (fixed 2026-09-28)

**Rule: the default `units` list is the *prefix-aware* mathjs set, derived programmatically from mathjs tables â never hand-maintained, never plain `Object.keys(math.Unit.UNITS)`.**

mathjs stores prefixed units as prefix Ã base, not as `UNITS` keys: `m`, `s`, `g` are keys, but `km`, `cm`, `mm`, `kg` are not. Hosts that classify symbols by exact membership against `vocabulary.units` therefore misclassify prefixed unit symbols as unknown references. This matters because mathjs does **not** absorb every unit symbol into a unit-bearing construct: in operator contexts like `5 km^2` (mathjs parses this as `5 * pow(km, 2)`), a bare unit symbol survives as a `SymbolNode` and classification falls to the vocabulary. A prefix-blind list makes `m^2` work while `km^2` is treated as an unknown name.

Implementation (`src/ast/vocabulary.ts`, `deriveDefaultUnits()`): keep every `math.Unit.UNITS` key as-is; for each unit's own prefix table, generate `prefix + symbol` candidates; keep a candidate only if `Unit.isValuelessUnit()` accepts it, so the list can never drift from what mathjs actually parses. Result: 251 base keys â 2770 entries (prefixÃbase candidates all accepted; long-name forms like `kilometer` included because mathjs accepts them). Interface shape unchanged â additive content only. Tests: prefixed spot-checks (`km`, `cm`, `mm`, `kg`, `kN`, `MPa`), `isValuelessUnit` on every entry, and a size-sanity band (between 4Ã and 30Ã the `UNITS` key count) that tolerates mathjs version drift but catches a broken derivation.

## Isomorphism & subpath exports

- `toMathML()` / `toMathNode()` / `fromJSON()` are pure tree-walking code â they run in Node as well as the browser. Hosts evaluate server-side with the same conversion path as the browser.
- **Subpath exports from day one**: the AST/serialization/conversion entry point (server-importable) is separate from the editor/DOM/caret entry point (browser-only). Browser-only deps stay out of the AST entry point.
- **The AST core (`./ast` subpath) is framework-free, permanently.** Pure `(tree) â tree` code with no UI state; a framework in this layer would break the isomorphism and hurt embeddability (usable from React/Vue/plain-JS hosts, not just one ecosystem). The future editor layer (`./editor` subpath) will be framework-compiled â framework + version still an open item.

## Evaluation bridge

- **Direct ASTâmathjs node objects, never strings.** Fold n-ary chains left-associatively into binary `OperatorNode`s (`op[+][1,2,3]` â `Op('+','add',[Op('+','add',[1,2]),3])`); `GroupNode(parens:'always')` â `ParenthesisNode`. The expression tree is derived, never stored â every evaluation folds fresh.
- `math.parse` has no place in Integral: **Integral never parses text.** Text parsing (input boundaries, paste of external plain-text math) belongs to host applications. Rejected permanently: `AST â string â math.parse()` â string round-trips lose visual structure and make text a second source of truth.

## Editing layer (decided principles, implementation later)

Not Day-1 scope, but decided so the AST never needs redesign:

- **Tree = dumb data; engine = all decisions.** Node classes carry structure + serialization + the four conversions only. No editing methods on nodes.
- **Editing engine** (separate subpath, runtime-agnostic): applies **ops as values** (`Insert`, `DeleteAt`, `MoveCaret` as pure `(tree, op) â tree'`). Undo = op log; property-testable without DOM.
- **Per-type nav profiles as data** (registry, editor entry point only â keeps the isomorphic subpath clean): each node type declares its caret geography (slots, horizontal adjacency, exits, flows â e.g. fraction: numerator flows *down into* denominator, never sideways). Engine interprets profiles type-blind; adding a node type = adding a profile, never touching the engine. (Successor of the 2025 prototype's `connectLeft`/`receiveRight` message passing, expressed as data.)
- **Insertion policy decides structure once, at edit time.** The hard problem where the 2025 prototype stalled. A bounded precedence-aware attach algorithm: lower/equal precedence than context op â wrap context; higher â nest in right operand; user parens â new GroupNode. **Tested against `math.parse` output as oracle**: walking mathjs's parse tree vs. simulating typed insertion must yield identical ASTs. Operator-swap rules inherit the same oracle.
- **Editing-session state stays local until blur**: the op log, undo, caret, and soft edit-lock are pure in-memory session state. Host persistence is touched once on blur, never during the edit.
- **Operator-swap rules** (operator replacement on an n-ary chain): higher-precedence replacement â wrap the two adjacent operands (i, i+1) in the new node and splice back in place; lower-precedence replacement â split the chain at i: changed op becomes/joins the new lower-precedence parent, untouched same-op operands stay grouped among themselves â handles both left and right splits with no asymmetry. Edge rules: consecutive changed ops with equal precedence merge into one flat node; Ã· never flattens (treat ÃâÃ» swap as parent-split with Ã· binary); precedence ties are where editors diverge from CAS expectations â property-test explicitly.
- **Structural nodes self-group; GroupNode is only for user-expressed parents.** FractionNode/PowerNode/RootNode slots are unambiguous slots â wrapping their contents in GroupNode would be redundant. `auto` groups are a *rendering* concern: they must never be written back into the stored tree.
- **No separate "semantic" format** The AST already *is* the semantic structure (near-isomorphic to mathjs's parse tree); a second format would be a second source of truth and break op-log replay (ops address the AST tree by path). Schema evolution = storage migration problem: budget a `migrate(json) â json` step in `fromJSON` from commit one.

## Implementation status (2026-09-28)

AST core implemented: 10 node classes, toJSON/fromJSON + invariant validation, toMathNode fold, isEvaluable, vocabulary types + **prefix-aware** default static vocabulary (`deriveDefaultUnits()`, 2770 unit entries), toMathML throwing stub. 68 tests passing, incl. oracle fixtures evaluating identically to `math.parse(...).evaluate()` (hand-written literals in tests until editor output exists). pnpm pinned `10.34.5` via `packageManager` field.

Pre-npm note: hosts consuming Integral via a package link each bundle their own mathjs copy alongside Integral's â unit instances are not `instanceof`-compatible across that boundary; hosts should duck-type units. Bundle-time dedup is a packaging concern for the npm switch.

## Open items

- Framework + version for the editor layer (interacts with nav-profile/editing-engine design) â must not block the AST core; `./editor` stays a placeholder until decided.
- NumberNode: `number` for v1; bignumber mode later = additive value-format flag, not structural.
- Subscript index-mode export policy (`x_n` as accessor) â when sequences exist.
- Nav-profile data schema details (vertical edges, empty-slot placeholders, selection) â when the editing engine is built.
