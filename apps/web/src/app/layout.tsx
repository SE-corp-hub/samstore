import type { Metadata } from "next";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./globals.css";
import "./polish.css";
import PwaRegister from "../components/PwaRegister";

export const metadata: Metadata = {
  title: "Sam's Store — Order Online",
  description: "Order online from Sam's Store — fresh Filipino favorites, delivered.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Rice Ops M10: installable store app + the low-vision typeface for the store screens */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#1F6F3F" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}