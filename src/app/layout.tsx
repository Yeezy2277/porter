import type { Metadata, Viewport } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import { Instrument_Sans, Martian_Mono } from "next/font/google";
import { ThemeToggle, themeScript } from "@/components/ThemeToggle";
import "./globals.css";

// Self-hosted from Fontsource (OFL): Google serves this family from URLs
// without a file extension, which next/font/google can't download.
const stencil = localFont({
  src: [
    { path: "../../node_modules/@fontsource/big-shoulders-stencil/files/big-shoulders-stencil-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "../../node_modules/@fontsource/big-shoulders-stencil/files/big-shoulders-stencil-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--nf-stencil",
  display: "swap",
  fallback: ["Arial Narrow", "Helvetica Neue", "sans-serif"],
});
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--nf-sans", display: "swap" });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["300", "500"], variable: "--nf-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Porter: legacy CMS to Contentful", template: "%s | Porter" },
  description: "A migration assistant that moves a legacy CMS export into Contentful: code converts the text, AI proposes mappings and links, people approve.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#efe4cf" },
    { media: "(prefers-color-scheme: dark)", color: "#12131c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${stencil.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <header className="masthead">
          <div className="wrap masthead__row">
            <Link href="/" className="brand" aria-label="Porter, home">
              <span className="brand__mark" aria-hidden="true">
                P
              </span>
              <span className="brand__name">Porter</span>
            </Link>
            <p className="masthead__route mono" aria-label="Route: WordPress to Contentful">
              <span>WordPress</span>
              <span aria-hidden="true">→</span>
              <span>Contentful</span>
            </p>
            <ThemeToggle />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="footer">
          <div className="wrap footer__row">
            <span>Sample data: a fictional travel magazine. No real sites are contacted.</span>
            <span className="mono">Times in UTC</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
