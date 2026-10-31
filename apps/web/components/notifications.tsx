"use client";

import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui";

// ponytail: no notifications backend exists yet (no /v1/notifications or
// equivalent feed) — rather than fabricate mock alerts, this renders an
// honest empty state. Wire this up once a real source lands.
export function Notifications() {
  return (
    <Popover>
      <Tooltip label="Notifications">
        <PopoverTrigger
          aria-label="Notifications"
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <Bell className="h-4 w-4" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0">
        <h3 className="border-b border-line px-4 py-3 text-[13px] font-semibold text-fg">Notifications</h3>
        <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
          <Bell className="h-5 w-5 text-fg-3" aria-hidden />
          <p className="text-[13px] text-fg-2">You’re all caught up.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
