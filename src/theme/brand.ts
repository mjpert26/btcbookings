/**
 * Big Think Capital brand configuration. This is the single place to change branding.
 * Colors were sampled from the official logo files. Contrast ratios are against white
 * (#FFFFFF) unless noted; text colors must stay at 4.5:1 or higher (WCAG AA).
 */
export const brand = {
  name: "Big Think Capital",
  shortName: "BTC",
  productName: "BTC Scheduling",
  websiteUrl: "https://www.bigthinkcapital.com",
  supportEmail: "support@bigthinkcapital.com",
  logo: {
    light: { src: "/brand/btc-logo.png", width: 441, height: 183 },
    // The supplied "dark" file uses the same blue wordmark, so it is only used on light or mid surfaces.
    dark: { src: "/brand/btc-logo-dark.webp", width: 1477, height: 610 },
    mark: { src: "/brand/btc-mark.png", width: 512, height: 512 },
    alt: "Big Think Capital",
  },
  colors: {
    primary: "#0D66A5", // BTC Blue. 6.07:1 on white: text and buttons.
    primaryHover: "#0B5A91",
    primaryForeground: "#FFFFFF",
    sky: "#22A4DC", // Gradient highlight. 3.1:1 on white: decorative only; 6.0:1 on navy surfaces.
    navy: "#0B3D66", // 11.2:1 on white: headings, dark surfaces.
    ink: "#0F172A",
    muted: "#475569", // 7.5:1 on white
    surface: "#FFFFFF",
    surfaceAlt: "#F4F8FB",
    border: "#D7E3EE",
    success: "#15803D",
    warning: "#B45309",
    danger: "#B91C1C",
  },
  fonts: {
    // Loaded with next/font in src/app/layout.tsx.
    heading: "Montserrat",
    body: "Inter",
  },
  radius: "0.75rem",
} as const;

export type Brand = typeof brand;
