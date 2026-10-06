/**
 * Rebalancing math. `trade` = amount to buy (+) / sell (−) to reach the target weight with the
 * current total; `contribution` = how to split a new deposit across underweight groups only
 * (no sales), filling the largest gaps first proportionally.
 */
export interface RebalanceInput {
  key: string;
  value: number;
  /** Target weight 0..1 (0 = no target). */
  target: number;
}

export interface RebalanceRow extends RebalanceInput {
  weight: number;
  trade: number;
  contribution: number;
}

export function rebalance(items: RebalanceInput[], newMoney = 0): { rows: RebalanceRow[]; total: number } {
  const total = items.reduce((s, i) => s + i.value, 0);
  const targeted = items.filter((i) => i.target > 0);
  const targetSum = targeted.reduce((s, i) => s + i.target, 0);
  const after = total + Math.max(0, newMoney);
  const norm = (i: RebalanceInput) => (targetSum > 0 ? i.target / targetSum : 0);
  // Gaps with the contribution included.
  const gaps = new Map(targeted.map((i) => [i.key, Math.max(0, norm(i) * after - i.value)]));
  const gapSum = [...gaps.values()].reduce((s, g) => s + g, 0);
  const rows = items
    .map((i) => {
      let contribution = 0;
      if (newMoney > 0 && i.target > 0) {
        const gap = gaps.get(i.key) ?? 0;
        // Fill the gaps first; any remainder is split by target weight.
        contribution = gapSum >= newMoney ? newMoney * (gap / gapSum) : gap + (newMoney - gapSum) * norm(i);
      }
      return {
        ...i,
        weight: total ? i.value / total : 0,
        trade: i.target > 0 ? norm(i) * total - i.value : 0,
        contribution,
      };
    })
    .sort((a, b) => b.value - a.value);
  return { rows, total };
}
