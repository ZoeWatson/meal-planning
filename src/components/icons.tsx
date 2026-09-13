/** Tab and inline icons. Inline SVG so they work offline with no font or asset fetch. */

interface IconProps {
  readonly size?: number;
}

function Svg({ children, size = 22 }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const CartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.5a2 2 0 0 0 2-1.5L20.5 8H6" />
    <circle cx="9.5" cy="20" r="1.4" />
    <circle cx="17.5" cy="20" r="1.4" />
  </Svg>
);

export const BookIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z" />
    <path d="M8 3v18" />
  </Svg>
);

export const PotIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h16v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
    <path d="M2 9h20M6 9V7M18 9V7" />
    <path d="M9 5c0-1 1-1.4 1-2.5M15 5c0-1 1-1.4 1-2.5" />
  </Svg>
);

export const JarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3h8M7 7h10v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" />
    <path d="M7 7V5a2 2 0 0 1 2-2M17 7V5a2 2 0 0 0-2-2" />
    <path d="M7 12h10" />
  </Svg>
);

export const WalletIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1" />
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
    <path d="M21 14h-4a2 2 0 0 1 0-4h4z" />
  </Svg>
);

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
  </Svg>
);

export const PinIcon = ({ filled = false, size = 18 }: IconProps & { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
  </svg>
);

export const CheckIcon = ({ size = 15 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

export const ShuffleIcon = ({ size = 17 }: IconProps) => (
  <Svg size={size}>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </Svg>
);

/** Two things trading places — swapping one ingredient in a recipe for another. */
export const SwapIcon = ({ size = 15 }: IconProps) => (
  <Svg size={size}>
    <path d="M6 7h14M16 3l4 4-4 4" />
    <path d="M18 17H4M8 21l-4-4 4-4" />
  </Svg>
);

/** The cupboard something is going into, on the button that puts it there. */
export const HouseIcon = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6 9.5V20h12V9.5" />
    <path d="M10 20v-6h4v6" />
  </Svg>
);

/**
 * The fold marker on a section heading.
 *
 * One glyph, pointing right, turned by CSS when the section opens. Two icons
 * would be two shapes to keep in step, and swapping them mid-animation is how a
 * caret ends up snapping through 90 degrees instead of turning.
 *
 * Heavier stroke than the rest: at 14px the shared 1.8 weight scales down to
 * roughly a hairline, and a hairline caret reads as an artefact.
 */
export const CaretIcon = ({ size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4.5 16.5 12 9 19.5" />
  </svg>
);
