import "./globals.css";

export const metadata = {
  title: "Grain Desk",
  description: "Wheat marketing tracker",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
