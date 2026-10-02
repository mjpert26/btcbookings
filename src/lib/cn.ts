import { clsx, type ClassValue } from "clsx";

/** Joins class names. Callers avoid passing conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
