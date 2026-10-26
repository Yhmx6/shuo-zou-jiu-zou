export type ReasonProps = {
  text: string;
};

/**
 * reason 的一句话：左侧细线的引用式正文。
 * 纯展示，不带任何交互或状态。
 */
export default function Reason({ text }: ReasonProps) {
  return (
    <p className="border-l-2 border-stone-300 pl-4 text-base leading-7 text-stone-700">
      {text}
    </p>
  );
}
