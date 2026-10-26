export type StartButtonProps = {
  onClick: () => void;
  busy: boolean;
};

/**
 * 首屏唯一的按钮：现在就走 / 正在安排…
 * 大号、全宽、深色底白字；busy 时禁用，防止重复提交。
 */
export default function StartButton({ onClick, busy }: StartButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="w-full rounded-2xl bg-stone-900 px-6 py-4 text-lg font-medium text-white transition duration-150 hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 active:translate-y-px active:bg-stone-950 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? "正在安排…" : "现在就走"}
    </button>
  );
}
