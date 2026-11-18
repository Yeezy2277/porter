import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Big_Shoulders_Stencil, Instrument_Sans, Martian_Mono } from "next/font/google";
import { ThemeToggle, themeScript } from "@/components/ThemeToggle";
import "./globals.css";

const stencil = Big_Shoulders_Stencil({ subsets: ["latin"], weight: ["300", "800"], variable: "--nf-stencil", display: "swap" });
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
