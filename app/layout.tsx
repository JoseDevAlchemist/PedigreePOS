import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";

import { AuthProvider } from "@/components/auth-provider";

import "./globals.css";

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "Pedigree POS",
  icons: {
    icon: "/pedigree-logo.png",
  },
  title: {
    default: "Pedigree POS",
    template: "%s · Pedigree POS",
  },
  description:
    "Point of sale for the Pedigree Leather workshop. Works offline; syncs when the connection returns.",
  // `app/manifest.ts` is served at /manifest.webmanifest and Next injects the
  // <link rel="manifest"> itself, so it is not repeated here.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pedigree POS",
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#5d4037",
  // The till runs at 1024px and up; letting the browser zoom would defeat a
  // grid of touch targets, so the layout owns its own scaling.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${cormorant.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
