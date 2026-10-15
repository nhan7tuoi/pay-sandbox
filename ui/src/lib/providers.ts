import type { ProviderFilter, ProviderName } from "./types";

export interface ProviderMeta {
  label: string;
  /** Brand-ish accent used for the provider dot and active tab. */
  color: string;
}

export const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
  stripe: { label: "Stripe", color: "oklch(0.62 0.2 277)" },
  momo: { label: "MoMo", color: "oklch(0.58 0.22 350)" },
  zalopay: { label: "ZaloPay", color: "oklch(0.6 0.2 258)" },
  vnpay: { label: "VNPay", color: "oklch(0.62 0.17 240)" },
};

export const PROVIDER_TABS: Array<{ id: ProviderFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "stripe", label: "Stripe" },
  { id: "momo", label: "MoMo" },
  { id: "zalopay", label: "ZaloPay" },
  { id: "vnpay", label: "VNPay" },
];
