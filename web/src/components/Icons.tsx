interface IconProps {
  className?: string | undefined;
}

function StrokeIcon({
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <StrokeIcon className={className}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </StrokeIcon>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <StrokeIcon className={className}>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </StrokeIcon>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <StrokeIcon className={className}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5v5" />
      <path d="M12 16.25h.01" />
    </StrokeIcon>
  );
}
