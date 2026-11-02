/**
 * Builds a vendor deep link for QR scanning. Only real vendor links: device
 * pairing QR codes come from the server-issued enrollment code
 * (POST /v1/bridges/enroll, Settings → Devices), never minted in the browser.
 * Returns null when the target is unknown, so no QR is shown for it.
 */
export function buildQRLink(params: {
  type: "whatsapp" | "telegram";
  botUsername?: string;
  /** The DISPLAY phone number (E.164). Never a Meta Business "phone number ID". */
  phoneNumber?: string;
}): string | null {
  switch (params.type) {
    case "whatsapp": {
      const phone = (params.phoneNumber ?? "").replace(/[^0-9]/g, "");
      return phone ? `https://wa.me/${phone}?text=${encodeURIComponent("Connect to PAL")}` : null;
    }
    case "telegram": {
      const bot = (params.botUsername ?? "").trim().replace(/^@/, "");
      return /^[A-Za-z0-9_]{5,32}$/.test(bot) ? `https://t.me/${bot}?start=connect` : null;
    }
  }
}
