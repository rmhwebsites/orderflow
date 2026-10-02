import type { Metadata } from "next";
import { Sora, Red_Hat_Display, Red_Hat_Mono } from "next/font/google";
import { APP_NAME } from "@/lib/brand";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

const redHatDisplay = Red_Hat_Display({
  subsets: ["latin"],
  variable: "--font-red-hat-display",
});

const redHatMono = Red_Hat_Mono({
  subsets: ["latin"],
  variable: "--font-red-hat-mono",
});

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning: theme-init.js may set data-theme on <html>
  // before React hydrates.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          A plain blocking script on purpose, so the stored theme lands before
          first paint. next/script's beforeInteractive does not do that in the
          App Router: it queues the file for Next's client bootstrap, which
          runs after the async framework chunks (and so possibly after first
          paint). See node_modules/next/dist/client/script.js.
        */}
        <script src="/theme-init.js" />
      </head>
      <body
        className={`${sora.variable} ${redHatDisplay.variable} ${redHatMono.variable} min-h-dvh bg-bg font-sans text-ink`}
      >
        {children}
      </body>
    </html>
  );
}
