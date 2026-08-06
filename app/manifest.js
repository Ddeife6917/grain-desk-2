export default function manifest() {
  return {
    name: "Grain Desk",
    short_name: "Grain Desk",
    description: "Wheat marketing tracker",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#1F5C34",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
