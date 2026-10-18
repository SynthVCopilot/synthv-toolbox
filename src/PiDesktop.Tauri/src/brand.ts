/** Product identity for the renderer; mirrors electron/brand.ts (checked by test/brand-identity.mjs). */
export const BRAND = {
  productName: "Toneshuttle",
  productNameZh: "声梭",
  slug: "toneshuttle",
  logo: "./assets/brand-logo.svg",
  repositoryUrl: "https://github.com/SynthVCopilot/synthv-toolbox",
} as const;

/** Name shown in running text for the active interface language. */
export function productName(locale: string): string {
  return locale.startsWith("zh") ? BRAND.productNameZh : BRAND.productName;
}
