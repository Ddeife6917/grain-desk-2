import "./globals.css";

export const metadata = {
  title: "Grain Desk",
  description: "Wheat marketing tracker",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Grain Desk",
  },
};

export const viewport = {
  themeColor: "#1F5C34",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
