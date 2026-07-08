import type { JSX } from 'react'

/**
 * Brand icons for agent providers, prop-compatible with lucide icons
 * (size / className; strokeWidth is accepted but these marks are fill-based).
 */
export interface BrandIconProps {
  size?: string | number
  strokeWidth?: string | number
  className?: string
}

/** Claude's starburst/asterisk mark. */
export function ClaudeIcon({ size = 16, className }: BrandIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M14.6 13.05L22.4 13.05L22.4 10.95L14.6 10.95ZM13.73 14.21L18.14 16.76L19.19 14.94L14.78 12.39ZM12.39 14.78L15.74 20.58L17.56 19.53L14.21 13.73ZM10.95 14.6L10.95 20.3L13.05 20.3L13.05 14.6ZM9.79 13.73L6.04 20.22L7.86 21.27L11.61 14.78ZM9.22 12.39L4.72 14.99L5.77 16.81L10.27 14.21ZM9.4 10.95L2.5 10.95L2.5 13.05L9.4 13.05ZM10.27 9.79L5.51 7.04L4.46 8.86L9.22 11.61ZM11.61 9.22L7.76 2.55L5.94 3.6L9.79 10.27ZM13.05 9.4L13.05 4.3L10.95 4.3L10.95 9.4ZM14.21 10.27L17.51 4.56L15.69 3.51L12.39 9.22ZM14.78 11.61L19.8 8.71L18.75 6.89L13.73 9.79Z" />
    </svg>
  )
}

/** OpenAI's hexagonal knot mark, simplified. */
export function CodexIcon({ size = 16, className }: BrandIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.72 4.09L17.98 6.9L17.28 9.71L6.02 6.9ZM16.21 3.48L19.41 14.63L16.62 15.42L13.42 4.27ZM21.49 11.39L13.43 19.73L11.34 17.71L19.4 9.37ZM17.28 19.91L6.02 17.1L6.72 14.29L17.98 17.1ZM7.79 20.52L4.59 9.37L7.38 8.58L10.58 19.73ZM2.51 12.61L10.57 4.27L12.66 6.29L4.6 14.63Z" />
    </svg>
  )
}
