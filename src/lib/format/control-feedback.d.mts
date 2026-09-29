export interface ControlFeedback {
 driver: string; kind?: string; mode?: string; state?: string; reason: string; severity?: string;
 site_meter?: string; site_before_w?: number | null; site_after_w?: number | null; site_before_at_ms?: number; site_after_at_ms?: number;
 verification_tier?: number | null; site_confirmation?: string; site_delta_w?: number | null; device_delta_w?: number | null;
 tolerance_w?: number | null; response?: string; requested_w?: number | null; sent_w?: number | null; readback_w?: number | null;
 actual_w?: number | null; requested_a?: number | null; offered_a?: number | null; device_limit_a?: number | null;
 device_reason?: string; observed_at_ms?: number; verified_at_ms?: number;
}
export function feedbackRows(value: unknown): ControlFeedback[];
export function feedbackText(row: ControlFeedback, live?: boolean): {title:string;detail:string;action:string};
export function feedbackPower(value: unknown, kind?: string): string;
export function feedbackValues(row: ControlFeedback, live?: boolean): [string,string][];
export function feedbackProof(row: ControlFeedback, live?: boolean): string;
export function renderFeedback(root: HTMLElement | null, value: unknown, live?: boolean): void;

export function feedbackSite(row: ControlFeedback, live?: boolean): string;
