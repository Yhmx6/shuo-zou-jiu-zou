/**
 * M7：会话内的临时类目权重（**只在内存里**，不落盘、不写文件、不进浏览器存储）。
 *
 * 「换一个」和「不感兴趣」两种动作的信号方向相反，绝不能混：
 * - 「换一个」= 中性 / 发散信号：调用方**不许**碰这个模块的任何写方法，权重保持原值（默认 1）；
 * - 「不感兴趣」= 负反馈 / 收敛信号：declareDislike 把该类目权重 × 0.2，仅本次进程会话生效。
 *
 * 持久化（跨会话、三次升级为长期偏好）是 M12 的事，M7 不提前做。
 * 进程重启后这里自然清空，不需要任何清理逻辑——这就是「仅本次会话」的实现。
 */

/** M7 3.1：点一次「不感兴趣」，该类目权重 × 0.2。 */
const DISLIKE_FACTOR = 0.2;

/** 类目 → 当前会话权重。没有记录 = 1（未降权）。 */
const sessionWeights = new Map<string, number>();

/**
 * 记一次「不感兴趣」：把该类目的当前权重 × 0.2。
 * 同一类目连续点多次会继续相乘（0.2 → 0.04 → …），这是「每一次点击都是一次负反馈」的口径。
 */
export function declareDislike(category: string): void {
  if (typeof category !== "string" || category.trim() === "") {
    throw new Error(`declareDislike 需要非空的类目名，收到：${String(category)}`);
  }
  sessionWeights.set(category, getWeight(category) * DISLIKE_FACTOR);
}

/** 读当前会话权重：未命中（从没被「不感兴趣」过）返回 1。 */
export function getWeight(category: string): number {
  const weight = sessionWeights.get(category);
  return weight === undefined ? 1 : weight;
}

/** 清空本次会话的所有临时权重（只影响内存；M7 没有任何持久化数据要清）。 */
export function resetSession(): void {
  sessionWeights.clear();
}
