# Integral — Editor & AST Specification

> Generated 2026-09-25 (clean-repo restart). Integral is a standalone, isomorphic WYSIWYG math editor package; this spec is self-contained and must not reference any consuming project.

## What Integral is

A modern WYSIWYG math editor built on **direct AST manipulation** and **MathML Core rendering** (no contenteditable text surface, no LaTeX round-trips), with engineering features: units, constants, and a host-provided variable picker. It runs in the browser (editor, caret, DOM) and in Node (AST, serialization, conversion) from the same package via **subpath exports from day one**:

- AST/serialization/conversion entry point — server-importable, pure tree-walking code, no browser deps allowed.
- Editor/DOM/caret entry point — browser-only.

## AST ownership

Integral owns the AST **completely**: node types plus `toMathML()`, `toMathNode()` (math.js conversion), `toJSON()`/`fromJSON()`. **No editing methods on nodes** — caret navigation lives in the editing engine; nodes carry structure + serialization + the four conversions only.

## Node set (v1, frozen 2026-09-24)

| Type | JSON `type` | Fields | `toMathNode()` projection |
|---|---|---|---|
| NumberNode | `num` | `value: number` | `ConstantNode` |
| SymbolNode | `sym` | `name: string` | `SymbolNode` |
| OperatorNode (n-ary) | `op` | `op` (mathjs fn name: add, subtract, multiply, unaryMinus, …), `args: Node[]` | `OperatorNode` |
| FunctionNode (n-ary) | `fn` | `name: string`, `args: Node[]` | `FunctionNode` |
| GroupNode | `group` | `child: Node` (exactly one), `parens: 'always'` (only value in v1; `'auto'`/`'none'` additive later) | `ParenthesisNode` |
| FractionNode | `frac` | `num`, `den` | `OperatorNode('/', divide, [a,b])` |
| PowerNode | `pow` | `base`, `exp` | `OperatorNode('^', pow, [a,b])` |
| RootNode | `root` | `radicand`, `index?` (omit when null = square root) | `FunctionNode('sqrt' | 'nthRoot')` |
| SubscriptNode | `sub` | `base` (symbol name), `sub` (script) | flat `SymbolNode` (e.g. `x_max`) — label mode only in v1 |
| UnitNode | `unit` | `value: Node`, `unit: string` (mathjs unit syntax) | mathjs unit-bearing construct (roundtrip verified by spike) |

Deliberately **not** in v1: AssignmentNode (names live on the host's container — the AST is RHS-only), RelationalNode/ConditionalNode, MatrixNode/IndexNode/ArrayNode, BlockNode/ObjectNode/AccessorNode/FunctionAssignmentNode (probably never).

## Structural invariants (contract)

1. **GroupNode = order-of-operations marker, single child** (same purpose as mathjs's ParenthesisNode). Flat *visual* rows live in n-ary operator/function args, never in groups. A flat mixed token row inside a group is an **invalid state**; `fromJSON` must reject it.
2. **Precedence is structural, never derived.** `(5+4*3)/2` = frac(num: group(op[+](5, op[*](4,3))), den: 2). The AST never parses and never re-derives order of operations; projection is a pure relabel/fold.
3. **Same-op chains are flattened to n-ary** — pure chains only (`a+b+c` yes; `a+b-c` and `a*b/c` never share a node). mathjs has *no* n-ary operator nodes (strictly binary left-associative); n-ary is our deliberate design. Flattening discards no association because flat chains encode none.
4. **Subscript name identity**: two symbols are the same name iff their `toMathNode()` SymbolNode names are equal. Index semantics deferred; export policy decided later, node shape unchanged.
5. **Incomplete trees are legal JSON** (empty slots: `5+`, empty fraction). Persisted by the host on blur regardless of completeness. Evaluation is gated separately by `isEvaluable()` (pure tree walk). The JSON always represents exactly what the user sees.
6. **Assignment never in the AST** — the host's container carries the name.

## JSON format

- Envelope per formula: `{ "v": 1, "root": { …node } }`. **Versioned from commit one**; later changes must be additive.
- Short field names (machine-owned; the TS class API is the human-readable layer). Per-node `type` discriminator; type-tag meanings never change without a version bump.
- No UIDs, no caret state in JSON. Caret = path into the tree, owned by the editing engine; UIDs (click-to-caret, hover relations) are ephemeral, assigned at deserialization.
- Contract guarantee: `fromJSON(toJSON(ast))` roundtrip stability.

## Editing layer (decided principles, implementation later — NOT current scope)

- **Tree = dumb data; engine = all decisions.** No editing methods on nodes.
- **Editing engine** (separate subpath, runtime-agnostic): **ops as values** (`Insert`, `DeleteAt`, `MoveCaret` as pure `(tree, op) → tree'`). Undo = op log; collab-mergeable later; property-testable without DOM.
- **Per-type nav profiles as data** (registry; editor entry point only): each node type declares its caret geography (slots, horizontal adjacency, exits, flows — e.g. fraction: numerator flows *down into* denominator, never sideways). Engine interprets profiles type-blind; adding a node type = adding a profile, never touching the engine.
- **Insertion policy decides structure once, at edit time.** Bounded precedence-aware attach algorithm: lower/equal precedence than context op → wrap context; higher → nest in right operand; user parens → new GroupNode. **Tested against `math.parse` output as oracle**: walking mathjs's parse tree vs. simulating typed insertion must yield identical ASTs. Operator-swap rules inherit the same oracle.
- **Operator-swap rules (operator replacement on an n-ary chain):** higher-precedence replacement → wrap the two adjacent operands (i, i+1) in the new node and splice back in place (`op[-][5,2,1]`, first `−`→`×` → `op[-][op[*][5,2],1]`); lower-precedence replacement → split the chain at i: changed op becomes/joins the new lower-precedence parent, untouched same-op operands stay grouped (`op[*][2,3,4]`, first `×`→`+` → `op[+][2, op[*][3,4]]`). Edge rules: consecutive changed ops with equal precedence merge into one flat node; ÷ never flattens (×↔÷ swap = parent-split with ÷ binary); property-test precedence ties explicitly.
- **Evaluation bridge is direct AST→mathjs node objects, never strings.** Fold n-ary chains left-associatively into binary OperatorNodes; `GroupNode(parens:'always')` → `ParenthesisNode`, `auto` groups skipped. Fold is derived, never stored. **Rejected permanently: `AST → string → math.parse()`** — it loses FractionNode/RootNode visual structure, creates a second source of truth, and moves the `(5+3)*2` order-of-operations problem into production.
- **`math.parse` survives only at input boundaries** (string import/paste), never as an evaluation escape hatch. Once the editor is live, typing is key event → op → new tree (no string built at all).
- **Structural nodes self-group; GroupNode is only for user-expressed parens.** FractionNode/PowerNode/RootNode slots are unambiguous slots. `auto` groups are a *rendering* concern: never written back into the stored tree.
- **Editing-session state stays local until blur** (op log, undo, caret, soft edit-lock are in-memory session state; host persistence happens on blur; concurrent same-formula editing = host-side concern).

## Vocabulary interface (second versioned contract, alongside the JSON format)

Symbol classification (constant / unit / builtin / unknown-reference) is **not hardcoded into node classes** — classification comes from a vocabulary provided by the host at use time. Two layers:

1. **Static vocabulary** — constants, units, built-in functions. Passed once at editor init (`init({ vocabulary })`), not per formula. Used by autocomplete, highlighting, and host-side reference filtering.
2. **Contextual vocabulary** — dynamic per-context names for autocomplete/suggestions (per document, possibly per cursor position). Host-provided data lookup.

- **Integral ships defaults** for the static layer (standard mathjs constant/unit set) → works standalone with zero config; hosts override once.
- **Discipline rule: data in, decisions stay in Integral.** Both layers are plain data objects. The moment Integral accepts host behavior/callbacks with logic, it stops being an embeddable editor and becomes a framework. Data in — that's the line.

## Consumers that shaped the node design

1. **Editor**: caret navigation, MathML → structural design of nodes.
2. **Host DAG/reference detection**: clean symbol-vs-constant/unit/builtin distinction → vocabulary-based classification (requirements flow one way: host requirements into Integral's design, never a dependency).
3. **mathjs evaluation**: `toMathNode()` must preserve semantics exactly (the `(5+3)*2` nightmare) → constrains whether parentheses are explicit nodes or implied by structure.

## Implementation phasing

- **Current phase — AST core only:** node types, `toJSON`/`fromJSON`, `toMathNode()`, vocabulary interface, `isEvaluable()`, subpath exports, roundtrip + oracle tests. `toMathML()` is a throwing stub.
- **Deferred (editor layer):** caret navigation, MathML rendering, key handling, DOM wiring, insertion policy, operator swaps, nav profiles.

## Open items

- UnitNode `toMathNode()` roundtrip spike (what mathjs construct survives `50 mm` → AST → mathjs → evaluate — verify before freezing).
- NumberNode: `number` for v1; bignumber mode later = additive value-format flag, not structural.
- Subscript index-mode export policy (`x_n` as accessor) — when sequences exist.
- Nav-profile data schema details (vertical edges, empty-slot placeholders, selection) — when editing engine is built.
