export interface ControlFeedback {
 site_evidence?: { unmeasured_flows?: string[]; other_change_w?: number|null; adjusted_site_change_w?: number|null; unexplained_change_w?: number|null; tolerance_w?: number; samples?: number; window_s?: number; max_skew_ms?: number|null; trace?: {at_ms:number;device_change_w:number;adjusted_site_change_w:number}[] };
 driver: string; kind?: string; mode?: string; state?: string; reason: string; severity?: string;
 site_meter?: string; site_before_w?: number | null; site_after_w?: number | null; site_before_at_ms?: number; site_after_at_ms?: number;
 verification_lost?: boolean; verification_tier?: number | null; site_confirmation?: string; site_source_issue?: string; site_delta_w?: number | null; device_delta_w?: number | null;
 tolerance_w?: number | null; response?: string; requested_w?: number | null; sent_w?: number | null; readback_w?: number | null;
 battery_soc?: number | null; charge_resume_soc?: number | null; actual_w?: number | null; requested_a?: number | null; offered_a?: number | null; device_limit_a?: number | null;
 device_reason?: string; observed_at_ms?: number; verified_at_ms?: number;
}
export function feedbackRows(value: unknown): ControlFeedback[];
export function feedbackText(row: ControlFeedback, live?: boolean): {title:string;detail:string;action:string};
export function feedbackPower(value: unknown, kind?: string): string;
export function feedbackValues(row: ControlFeedback, live?: boolean): [string,string][];
export function feedbackProof(row: ControlFeedback, live?: boolean): string;
export function renderFeedback(root: HTMLElement | null, value: unknown, live?: boolean, options?: {compact?:boolean;expanded?:boolean;embedded?:boolean}): void;

export function feedbackSite(row: ControlFeedback, live?: boolean): string;
export function feedbackCurve(row: ControlFeedback, live?: boolean): {device:string;site:string;label:string;scale:string;duration:string}|null;

export function feedbackStatus(row: ControlFeedback, live?: boolean): {label:string;tone:string};

export interface ControlProof { label:string; detail:string; tone:string; inactive?:boolean }
export interface ProofPlanetScope { role?:string; name?:string; id?:string }
export function feedbackForPlanet(value:unknown, planet?:ProofPlanetScope): ControlFeedback[];
export function withControlProof<T>(planets:T[], value:unknown, live?:boolean): (T & {controlProof?:ControlProof})[];

export function feedbackSummary(value:unknown, live?:boolean): {label:string;tone:string};
