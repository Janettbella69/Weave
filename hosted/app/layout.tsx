import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Weave · 让我们的 Agent 一起行动",
  description: "独立个人空间、习惯 Agent 团队、朋友邀请与双方确认的共同安排。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
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
