import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NoteLah — your everyday workspace",
  description: "Plan your day, capture a thought, and see your progress. Your work stays with you.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
