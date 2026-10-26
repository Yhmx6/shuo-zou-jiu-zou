import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "说走就走",
  description: "本地半日行程生成器：按空闲时间挑几个地方，串成一条说走就走的路线。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
