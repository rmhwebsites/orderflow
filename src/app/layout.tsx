import type { Metadata } from "next";
import { Sora, Red_Hat_Display, Red_Hat_Mono } from "next/font/google";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-sora",
});

const redHatDisplay = Red_Hat_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-red-hat-display",
});

const redHatMono = Red_Hat_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-red-hat-mono",
});

export const metadata: Metadata = {
  title: "Order Desk",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${sora.variable} ${redHatDisplay.variable} ${redHatMono.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
