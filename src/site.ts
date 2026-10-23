export const SITE = {
  name: "Ice de Vera",
  description: "Software engineer. Building dohc.computer.",
};

export const LINKS = [
  { name: "GitHub", href: "https://github.com/icedevera" },
  { name: "LinkedIn", href: "https://linkedin.com/in/icedevera" },
];

export function formatDate(date: Date, month: "short" | "long" = "long") {
  return date.toLocaleDateString("en-GB", {
    day: month === "long" ? "numeric" : undefined,
    month,
    year: "numeric",
    timeZone: "UTC",
  });
}
