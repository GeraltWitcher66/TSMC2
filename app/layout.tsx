import type { Metadata } from "next";
import "@fontsource-variable/vazirmatn";
import "./globals.css";

export const metadata: Metadata = {
  title: "فیلتر بورس ایران",
  description: "دیده‌بان شخصی سهام بورس و فرابورس با تحلیل دقیق ۹۰ و ۱۸۰ روزه، RSI و سهامداران حقیقی عمده",
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
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
