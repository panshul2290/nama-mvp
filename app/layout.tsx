import type { Metadata, Viewport } from "next";
import { Nunito_Sans } from "next/font/google";
import "./globals.css";

const nunito = Nunito_Sans({ subsets: ["latin"], weight: ["400", "600", "700", "800"], variable: "--font-nunito" });

export const metadata: Metadata = {
  title: "Nama Tanker",
  description: "Order a water tanker and track it live.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#061a21",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={nunito.variable}>
      <body>
        <div className="stage">
          <div className="phone">{children}</div>
        </div>
      </body>
    </html>
  );
}
