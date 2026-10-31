import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import clsx from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

// Variant styles read from design tokens (--color-accent, --color-border-*,
// --elev-*) so swapping the palette in globals.css propagates everywhere
// without touching this file.
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-action text-on-action hover:bg-action/90 shadow-[var(--elev-1)]",
  secondary:
    "border border-line-strong bg-panel text-fg hover:bg-hover",
  ghost:
    "text-fg-2 hover:text-fg hover:bg-hover",
  danger:
    "bg-bad-soft text-bad border border-bad/30 hover:border-bad/60",
};

// Sizes read from --text-* + --radius-* so the type scale evolves in one place.
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1 rounded-md",
  md: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-md",
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>;

const BASE =
  "inline-flex items-center justify-center font-medium transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus-ring";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading,
      icon,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(BASE, VARIANT[variant], SIZE[size], className)}
        {...rest}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  },
);

interface LinkButtonProps extends CommonProps {
  href: string;
  external?: boolean;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  href,
  external,
}: LinkButtonProps) {
  const cls = clsx(BASE, VARIANT[variant], SIZE[size], className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {icon}
      {children}
    </Link>
  );
}
