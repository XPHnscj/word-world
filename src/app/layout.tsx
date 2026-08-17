import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "雅思语境记忆", template: "%s · 雅思语境记忆" },
  description: "用短文、主动回忆和间隔复习，把雅思词汇变成可调用的语言能力。",
  applicationName: "雅思语境记忆",
  keywords: ["雅思", "IELTS", "英语词汇", "语境学习", "间隔复习"],
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "雅思语境记忆",
    description: "语境阅读、主动回忆与间隔复习结合的本地优先学习工具。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><a className="skip-link" href="#main-content">跳到主要内容</a>{children}</body></html>;
}
