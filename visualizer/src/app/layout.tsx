import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/auth-context";
import { THEME_INIT_SCRIPT } from "@/utils/theme-init";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const heading = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Clio Visualizer",
  description: "Inspect recordings, motion and scenes with Clio.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The init script sets the theme class before hydration, hence the warning suppression.
    <html
      lang="en"
      className={`${sans.variable} ${heading.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
