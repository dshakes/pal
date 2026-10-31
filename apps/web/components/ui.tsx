"use client";
// v3 interactive primitives — thin, token-styled wrappers over Radix.
// Radix owns the hard a11y parts (focus trap + return, roving focus, escape,
// portals, aria wiring); these wrappers only add the PAL look. Everything here
// reads semantic tokens (fg / line / panel / accent), never literal colors.

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import clsx from "clsx";

const floating =
  "v3-pop z-[80] rounded-[10px] border border-line bg-panel text-fg shadow-[var(--elev-3)] outline-none";

// ── Dropdown menu ───────────────────────────────────────────────────────────

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenu.Content>>(
  function MenuContent({ className, sideOffset = 6, ...props }, ref) {
    return (
      <DropdownMenu.Portal>
        <DropdownMenu.Content ref={ref} sideOffset={sideOffset} className={clsx(floating, "min-w-[220px] p-1", className)} {...props} />
      </DropdownMenu.Portal>
    );
  },
);

export const MenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenu.Item> & { tone?: "danger" }>(
  function MenuItem({ className, tone, ...props }, ref) {
    return (
      <DropdownMenu.Item
        ref={ref}
        className={clsx(
          "flex h-[var(--control-h)] cursor-default select-none items-center gap-2.5 rounded-md px-2 text-[13px] outline-none",
          "data-[highlighted]:bg-hover data-[disabled]:opacity-45",
          tone === "danger" ? "text-bad" : "text-fg-2 data-[highlighted]:text-fg",
          className,
        )}
        {...props}
      />
    );
  },
);

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[12px] text-fg-3">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className="flex h-[var(--control-h)] cursor-default select-none items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-2 outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg data-[state=checked]:text-fg"
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
        </DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.RadioItem>
  );
}

// ── Popover ─────────────────────────────────────────────────────────────────

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  function PopoverContent({ className, sideOffset = 8, ...props }, ref) {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content ref={ref} sideOffset={sideOffset} className={clsx(floating, "w-72 p-3", className)} {...props} />
      </PopoverPrimitive.Portal>
    );
  },
);

// ── Tooltip ─────────────────────────────────────────────────────────────────

export const TooltipProvider = TooltipPrimitive.Provider;

/** Hover/focus label. Use for icon-only controls (which also carry aria-label). */
export function Tooltip({ label, side = "bottom", children }: { label: ReactNode; side?: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="v3-pop z-[90] rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-fg shadow-[var(--elev-2)]"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** Keyboard key cap, used in menus, tooltips and the ⌘K footer. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={clsx("inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-raised px-1 font-sans text-[11px] font-medium text-fg-3", className)}>
      {children}
    </kbd>
  );
}
