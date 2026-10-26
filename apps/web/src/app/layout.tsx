import type { Metadata, Viewport } from "next";
import "./globals.css";
import { NavBar } from "@/components/NavBar";
import { SiteFooter } from "@/components/SiteFooter";

const SITE_URL = "https://horizons.tools";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Horizons — 发现值得关注的 AI 工具",
    template: "%s · Horizons",
  },
  description:
    "用可追溯的信号，追踪值得关注的 AI 工具榜单——热度、定价、趋势，一目了然。",
  openGraph: {
    title: "Horizons — 发现值得关注的 AI 工具",
    description:
      "用可追溯的信号，追踪值得关注的 AI 工具榜单——热度、定价、趋势，一目了然。",
    url: SITE_URL,
    siteName: "Horizons",
    type: "website",
    locale: "zh_CN",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d12" },
  ],
};

/** 首屏前同步主题，避免浅/深色闪烁（FOUC） */
// 默认浅色；深色后续完善（用户手动切换，localStorage 记忆）
const themeInitScript = `(function(){try{var t=localStorage.getItem("theme")||"light";if(t==="dark"){document.documentElement.classList.add("dark");}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <div className="flex min-h-screen flex-col">
          <NavBar />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
