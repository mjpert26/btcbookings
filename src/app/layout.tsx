import type { Metadata } from "next";
import { Inter, Montserrat } from "next/font/google";
import { brand } from "@/theme/brand";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], weight: ["600", "700", "800"], display: "swap" });

export const metadata: Metadata = {
  title: { default: brand.productName, template: `%s · ${brand.productName}` },
  description: `Book time with ${brand.name}.`,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${montserrat.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-primary">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
