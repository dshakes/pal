import type { Metadata } from "next";
import { THEME_INIT_SCRIPT } from "@/lib/theme-init-script";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";

// Brand type (docs/brand): Inter Tight display, Inter text, JetBrains Mono code.
// Exposed as CSS vars consumed by @theme in globals.css.
// Self-hosted variable woff2 (latin subset, SIL OFL, from @fontsource-variable) so the
// build makes no network font fetch. Weight ranges cover the previously requested weights.
const interTight = localFont({ src: "./fonts/inter-tight-latin-wght-normal.woff2", weight: "100 900", variable: "--font-inter-tight", display: "swap" });
const inter = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", weight: "100 900", variable: "--font-inter", display: "swap" });
const jetbrains = localFont({ src: "./fonts/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", variable: "--font-jetbrains", display: "swap" });
export const metadata: Metadata = {
  title: "PAL Dashboard",
  description: "Manage your AI agents, monitor runs, and control your serverless agent platform.",
};

// This is an auth-gated, fully data-driven dashboard — render every route
// dynamically rather than statically prerendering at build time (which fails
// on client-only APIs like useSearchParams / localStorage during SSG).
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${interTight.variable} ${inter.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        {/* Runtime browser API URL (see lib/runtime-config.ts). Only emitted when the
            server env sets it, so local dev keeps its build-time default. */}
        {process.env.PAL_PUBLIC_API_URL !== undefined && (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__NEXT_PUBLIC_API_URL=${JSON.stringify(process.env.PAL_PUBLIC_API_URL).replace(/</g, "\\u003c")};`,
            }}
          />
        )}
        {/* No-flash theme init: set data-theme before paint. Dark is default (light via the toggle). */}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
