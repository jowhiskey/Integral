// Evaluation gate: a pure tree walk checking that all slots are filled and no
// operator is dangling. Incomplete trees are legal JSON but not evaluable.
//
// Scope (structural, by definition): isEvaluable() answers "is this tree
// structurally complete — every slot filled, every operator known and used
// with a legal arity?" — nothing more. It is NOT a guarantee that evaluation
// succeeds: a FunctionNode with zero args or an unknown function name passes
// this gate and then throws at evaluation, because function existence and
// arity are runtime concerns of the evaluating scope (host-defined functions
// can legitimately be zero-arg or unknown to this layer). Hosts that need a
// semantic guarantee must attempt the evaluation or check names against their
// own scope. This boundary is deliberate and pinned by tests.

import {
  AssignNode,
  FractionNode,
  FunctionNode,
  GroupNode,
  MathNode,
  OperatorNode,
  OPERATOR_SYMBOLS,
  PowerNode,
  RootNode,
  SubscriptNode,
  SymbolNode,
  UNARY_OPS,
  UnitNode,
  implicitPairLegal,
  projectsUnaryRow,
} from './nodes.js';

/**
 * The evaluation gate. `atRoot` marks the envelope's root call: assignment-ness
 * is an eval state that lives only at the ROOT (an assign nested in a slot —
 * seedable via fromJSON — refuses per this structural gate, A5/A6).
 */
export function isEvaluable(node: MathNode | null): boolean {
  return isEvaluableAt(node, true);
}

function isEvaluableAt(node: MathNode | null, atRoot: boolean): boolean {
  if (node === null) {
    return false;
  }
  switch (node.type) {
    case 'num':
      return true;
    case 'sym':
      return (node as SymbolNode).name !== '';
    case 'op': {
      const op = node as OperatorNode;
      if (!(op.op in OPERATOR_SYMBOLS)) return false;
      if (UNARY_OPS.has(op.op)) {
        return op.args.length === 1 && isEvaluableAt(op.args[0], false);
      }
      if (op.implicit) {
        // Glyph-less adjacency (Owner amendment): every cell must be filled
        // and every adjacent pair legal — a number before a non-number is
        // implicit multiplication; a symbol (any non-number) before anything
        // refuses; number next to number stays forbidden (S-098).
        return (
          op.args.length >= 2 &&
          op.op === 'multiply' &&
          op.args.every((arg) => isEvaluableAt(arg, false)) &&
          op.args.slice(1).every((arg, i) => arg !== null && op.args[i] !== null && implicitPairLegal(op.args[i]!, arg))
        );
      }
      if (op.op === 'add' || op.op === 'subtract') {
        // Math-style projection of empty-slot operator rows (Owner amendment):
        // leading `−` negates, leading `+` is identity, a doubled operator
        // acts on what follows. Trailing null, all-null, and two consecutive
        // null cells refuse (the projection pattern is exhaustive for the rest).
        return (
          projectsUnaryRow(op.args) &&
          op.args.every((arg) => arg === null || isEvaluableAt(arg, false))
        );
      }
      return op.args.length >= 2 && op.args.every((arg) => isEvaluableAt(arg, false));
    }
    case 'fn': {
      const fn = node as FunctionNode;
      // close === false: the movable closing fence is absent — unbalanced
      // states stand structurally refused (the existing gate, no new rule).
      return fn.close !== false && fn.name !== '' && fn.args.every((arg) => isEvaluableAt(arg, false));
    }
    case 'group':
      // close === false: see the fn case.
      return (node as GroupNode).close !== false && isEvaluableAt((node as GroupNode).child, false);
    case 'fence':
      // A close-fence glyph is never a value — dangling or paired, every
      // state that contains one is structurally incomplete for evaluation.
      return false;
    case 'frac':
      return isEvaluableAt((node as FractionNode).num, false) && isEvaluableAt((node as FractionNode).den, false);
    case 'pow':
      return isEvaluableAt((node as PowerNode).base, false) && isEvaluableAt((node as PowerNode).exp, false);
    case 'root': {
      const root = node as RootNode;
      // mroot with a null index is the empty-index-slot state — incomplete.
      return (
        isEvaluableAt(root.radicand, false) &&
        !(root.mroot && root.index === null) &&
        (root.index === null || isEvaluableAt(root.index, false))
      );
    }
    case 'sub':
      return (node as SubscriptNode).base !== '' && (node as SubscriptNode).sub !== '';
    case 'unit':
      return (node as UnitNode).unit !== '' && isEvaluableAt((node as UnitNode).value, false);
    case 'assign': {
      // A5/A6: assignment-ness is an EVAL STATE at the ROOT only — an assign
      // nested in a slot (seedable via fromJSON) refuses here. At the root:
      // the lhs exactly one bare SymbolNode with a non-empty name + the rhs
      // evaluable. Every other lhs shape (empty, number, multi-node row,
      // group, structure, unit) is DECLINED evaluation — storable, renders,
      // the node persists (no structural dissolve); the state flips live with
      // the lhs content, like unit-ness flips with the letter run.
      if (!atRoot) return false;
      const assign = node as AssignNode;
      return (
        assign.lhs !== null &&
        assign.lhs.type === 'sym' &&
        (assign.lhs as SymbolNode).name !== '' &&
        isEvaluableAt(assign.rhs, false)
      );
    }
  }
}
