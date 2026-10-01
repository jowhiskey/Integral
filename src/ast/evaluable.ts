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
} from './nodes.js';

export function isEvaluable(node: MathNode | null): boolean {
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
        return op.args.length === 1 && isEvaluable(op.args[0]);
      }
      return op.args.length >= 2 && op.args.every(isEvaluable);
    }
    case 'fn': {
      const fn = node as FunctionNode;
      return fn.name !== '' && fn.args.every(isEvaluable);
    }
    case 'group':
      return isEvaluable((node as GroupNode).child);
    case 'frac':
      return isEvaluable((node as FractionNode).num) && isEvaluable((node as FractionNode).den);
    case 'pow':
      return isEvaluable((node as PowerNode).base) && isEvaluable((node as PowerNode).exp);
    case 'root': {
      const root = node as RootNode;
      return isEvaluable(root.radicand) && (root.index === null || isEvaluable(root.index));
    }
    case 'sub':
      return (node as SubscriptNode).base !== '' && (node as SubscriptNode).sub !== '';
    case 'unit':
      return (node as UnitNode).unit !== '' && isEvaluable((node as UnitNode).value);
  }
}
