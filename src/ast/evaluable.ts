// Evaluation gate: a pure tree walk checking that all slots are filled and no
// operator is dangling. Incomplete trees are legal JSON but not evaluable.

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
