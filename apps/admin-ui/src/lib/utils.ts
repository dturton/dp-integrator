import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui's standard className composer: `clsx` for conditional classes,
 * `tailwind-merge` to resolve conflicting Tailwind utilities (e.g. so
 * `cn('px-2', 'px-4')` collapses to just `px-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
