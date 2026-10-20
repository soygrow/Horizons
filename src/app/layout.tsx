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
  themeColor: "#0b0d12",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
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
