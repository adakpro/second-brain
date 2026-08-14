import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  return {
    metadataBase,
    title: "Solari — Your living digital brain",
    description: "A private, self-hosted creative intelligence with a living knowledge stream, real-time voice, Hermes Agent, and Obsidian.",
    applicationName: "HERMESS",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      type: "website",
      title: "Solari — Your living digital brain",
      description: "A charismatic creative intelligence living inside your private Hermes and Obsidian brain.",
      images: [{ url: "/og-digital-brain.webp", width: 1536, height: 1024, alt: "A living HERMESS knowledge garden" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Solari — Your living digital brain",
      description: "A private, living creative intelligence powered by Hermes Agent and Obsidian.",
      images: ["/og-digital-brain.webp"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
