import type { AddressDetails } from "./address";
import type { RuleStatus, ServiceType } from "./pricing";

export type Role = "customer" | "driver" | "nws_staff" | "owner" | "business";
// Prototype "Users and roles": Super admin (admin), Control room operator (operator),
// Permit officer, Inspector, Complaints agent, Finance, Read-only BI (viewer).
export type StaffRole = "operator" | "permit_officer" | "admin" | "inspector" | "complaints_agent" | "finance" | "viewer";
export type OrgRole = "admin" | "site_manager" | "finance";

export type OrderStatus =
  | "scheduled"
  | "pending_approval"
  | "requested"
  | "accepted"
  | "arriving"
  | "arrived"
  | "collected"
  | "delivered"
  | "cancelled";

/** Orders still in progress (a tanker may be on its way). */
export const ACTIVE_STATUSES: OrderStatus[] = ["requested", "accepted", "arriving", "arrived", "collected"];
/** A tanker is assigned and working the job. */
export const ON_JOB_STATUSES: OrderStatus[] = ["accepted", "arriving", "arrived", "collected"];

export type Profile = {
  id: string;
  role: Role;
  staff_role?: StaffRole | null;
  full_name: string;
  phone: string | null;
  company_id?: string | null;
  org_id?: string | null;
  org_role?: OrgRole | null;
  id_type?: "civil_id" | "resident_card" | "passport" | null;
  id_no?: string | null;
  id_verified?: boolean;
  segment?: "household" | "commercial" | "government" | "farm";
  lang?: "en" | "ar";
  prefs?: Record<string, unknown>;
  account_blocked?: boolean;
  loyalty_points?: number;
  staff_zones?: string[];
  created_at?: string;
};

/** A company's invitation to a driver, or an organisation's to a business user (accepted by the invitee). */
export type Invitation = {
  id: string;
  kind: "driver" | "org_member";
  company_id: string | null;
  org_id: string | null;
  org_role: OrgRole | null;
  /** Exactly one of phone (E.164) and email (lower case) is set. */
  phone: string | null;
  email: string | null;
  invited_by: string | null;
  status: "pending" | "accepted" | "declined" | "revoked";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

// Tankers are identified by id; drivers link to them through tanker_assignments.
export type Tanker = {
  id: string;
  plate: string;
  service_type: ServiceType;
  capacity_gal: number;
  is_online: boolean;
  last_lat: number | null;
  last_lng: number | null;
  last_seen_at: string | null;
  last_fix_at?: string | null;
  last_accuracy_m?: number | null;
  blocked?: boolean;
  blocked_reason?: string | null;
  /** 0041 vehicle papers (Naql, operating card, insurance, tracking device). */
  naql_reg_no?: string | null; op_card_no?: string | null; op_card_expiry?: string | null; vin?: string | null; make?: string | null; model?: string | null;
  model_year?: number | null; tank_capacity_gal?: number | null; capacity_verified_gal?: number | null; insurance_company?: string | null;
  insurance_policy_no?: string | null; insurance_expiry?: string | null; tracking_device_id?: string | null;
  vehicle_status?: "unverified" | "submitted" | "verified" | "rejected"; vehicle_note?: string | null; vehicle_verified_at?: string | null;
  company_id?: string | null;
};

export type PayMethod = "wallet" | "card" | "omannet" | "wallet_card" | "account" | "cash";
export type PaymentStatus = "pending" | "authorized" | "captured" | "refunded" | "partially_refunded" | "failed" | "on_account";

export type Order = {
  id: string;
  /** Sequential, server-assigned; display as TO-<order_no>. */
  order_no: number;
  customer_id: string;
  driver_id: string | null;
  /** The tanker that served the order (set on acceptance). */
  tanker_id: string | null;
  service_type: ServiceType;
  gallons: number;
  area: string;
  water_charge: string;
  delivery_fee: string;
  discount?: string;
  vat: string;
  total: string;
  driver_earnings: string;
  status: OrderStatus;
  /** Status of the pricing rules behind each line when the order was priced. */
  price_basis: {
    water: RuleStatus;
    fee: RuleStatus;
    vat: RuleStatus;
    total: RuleStatus;
    earnings: RuleStatus;
    rules: string[];
    mode: string;
    peak?: boolean;
    priority?: boolean;
    discount_pct?: number;
    /** 0034: the whole breakdown, locked at booking. */
    version?: number;
    locked_at?: string;
    lines?: { water_charge: number; delivery_fee: number; discount: number; vat: number; total: number; driver_earnings: number };
    tariff?: { class_id: string; code: string; min_gal: number; max_gal: number | null; rate_baisa: number; status: RuleStatus; basis: string | null; slabs: { code: string; gallons: number; rate_baisa: number; status: RuleStatus }[] };
    delivery?: { charge_id: string; zone_id: string | null; zone: string | null; is_default: boolean; amount: number; status: RuleStatus; multiplier?: number; fee?: number };
    vat_rate?: number;
    driver_share?: number;
    adjustments?: { at: string; reason: string; delivery_fee: [number, number]; total: [number, number] }[];
  } | null;
  driver_name: string | null;
  tanker_plate: string | null;
  created_at: string;
  accepted_at: string | null;
  arriving_at: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  // Platform (0010)
  property_id?: string | null;
  org_id?: string | null;
  contract_id?: string | null;
  zone_id?: string | null;
  /** Placed in a test zone (0020, "Test – India"): tagged TEST, kept out of NWS KPIs. */
  is_test?: boolean;
  channel?: "app" | "call_centre" | "business" | "contract";
  genesys_id?: string | null;
  is_emergency?: boolean;
  slot_start?: string | null;
  slot_end?: string | null;
  slot_label?: string | null;
  slot_peak?: boolean;
  driver_note?: string | null;
  po_number?: string | null;
  billing?: "prepaid" | "account";
  promo_code?: string | null;
  pay_method?: PayMethod | null;
  payment_status?: PaymentStatus | null;
  /** 0043: why NWS finance follows the payment up (the delivery went ahead). */
  payment_followup?: "outage_pay_later" | "payment_pending" | "autopay_failed" | null;
  payment_followup_resolved_at?: string | null;
  /** 0044: the recurring plan that created it. */
  recurring_id?: string | null;
  released_at?: string | null;
  approved_at?: string | null;
  filled_at?: string | null;
  fill_site_id?: string | null;
  fill_meter_gal?: number | null;
  fill_verified?: boolean | null;
  collected_at?: string | null;
  discharged_at?: string | null;
  discharge_site_id?: string | null;
  discharge_verified?: boolean | null;
  rating?: number | null;
  rating_comment?: string | null;
  tip?: string;
  rated_at?: string | null;
  cancel_fee?: string;
  cancelled_by?: "customer" | "driver" | "staff" | "system" | "approver" | null;
  cancel_reason?: string | null;
  invoice_id?: string | null;
  /** Short delivery: the pro-rata share refunded to the wallet (prepaid) or credited on the account invoice. */
  short_credit?: string;
};

export type OrderLocation = { order_id: string; lat: number; lng: number; address: string } & AddressDetails;

export type OpenRequest = {
  id: string;
  order_no: number;
  service_type: ServiceType;
  gallons: number;
  area: string;
  distance_km: number;
  driver_earnings: string;
  earnings_status: RuleStatus | null;
  created_at: string;
  is_emergency?: boolean;
  slot_label?: string | null;
  slot_end?: string | null;
  channel?: string;
  contract_no?: number | null;
  is_test?: boolean;
  /** 0034: what to collect at the door (cash on delivery), 0 when paid in the app. */
  collect_omr?: string;
  pay_method?: PayMethod | null;
};

export type LngLat = { lat: number; lng: number };

export type Company = { id: string; name: string; cr_no: string; phone: string | null; rating: string; since: string; status: "pending" | "active" | "suspended" };
export type Organization = {
  id: string; name: string; cr_no: string; segment: string; credit_limit: string; terms_days: number; approval_limit: string;
  invoicing: string; paused: boolean; status: "pending" | "active" | "suspended"; vat_number?: string | null;
};
export type Zone = {
  id: string; name: string; governorate: string; center_lat: number; center_lng: number; radius_km: string; active: boolean;
  /** Test zone (0020): contains exactly its bounding box, ranks after every real zone. */
  is_test?: boolean; min_lat?: number | null; max_lat?: number | null; min_lng?: number | null; max_lng?: number | null;
  /** Auto-dispatch (0026): offer each request to the best tanker for offer_seconds, then the next. */
  auto_offer?: boolean; offer_seconds?: number;
};
export type Site = { id: string; code: string; kind: "fill" | "discharge"; name: string; service_types: ServiceType[]; lat: number; lng: number; radius_m: number; operator: string; active: boolean; is_test?: boolean };
export type Property = { id: string; customer_id: string | null; org_id: string | null; label: string; address: string; area: string; lat: number; lng: number; tank_gal: number; created_at: string } & AddressDetails;
export type Contract = {
  id: string; contract_no: number; customer_id: string | null; org_id: string | null; property_id: string; company_id: string; service_type: ServiceType;
  gallons: number; frequency: "weekly" | "biweekly" | "monthly"; plan: "monthly" | "yearly"; slot: "morning" | "evening";
  start_date: string; end_date: string; monthly_est: string; status: "pending_owner" | "active" | "paused" | "ended" | "declined"; created_at: string;
};
export type WalletTx = { id: number; customer_id: string; kind: string; amount: string; order_id: string | null; memo: string; created_at: string };
export type CompanyTx = { id: number; company_id: string; driver_id: string | null; tanker_id: string | null; bucket: "earnings" | "fill_credit"; kind: string; amount: string; order_id: string | null; memo: string; created_at: string };
export type Payment = { id: string; order_id: string; customer_id: string | null; org_id: string | null; method: PayMethod; amount: string; wallet_amount: string; card_amount: string; card_last4: string | null; status: PaymentStatus; gateway_ref: string | null; failure_reason: string | null; refunded_amount: string; created_at: string; captured_at: string | null; confirmed_at?: string | null; kind?: "order" | "tip"; refunded_to_card?: string };
export type Pod = {
  order_id: string; kind: "delivery" | "collection"; photo_path: string | null; photo_hash: string | null; meter_gal: number; signature_svg: string | null;
  no_signature: boolean; left_at_tank: boolean; lat: number | null; lng: number | null; created_at: string; status: "accepted" | "rejected";
  // Location evidence (0024): the submit fix and the photo's fix, each with accuracy, time and distance from the delivery point.
  accuracy_m?: number | null; fix_at?: string | null; location_source?: "device" | "tanker" | null; distance_m?: number | null;
  photo_lat?: number | null; photo_lng?: number | null; photo_accuracy_m?: number | null; photo_at?: string | null; photo_distance_m?: number | null;
  photo_source?: "camera" | "gallery" | null;
};
export type Complaint = {
  id: string; case_no: number; order_id: string | null; customer_id: string | null; category: string; description: string; photo_path: string | null;
  channel: "app" | "call_centre" | "business"; genesys_id: string | null; state: "new" | "assigned" | "escalated" | "resolved"; owner_team: string | null;
  sla_hours: number; due_at: string; refund_amount: string; resolution: string | null; created_at: string; resolved_at: string | null;
  /** 0035/0039: high when escalated by the customer to 1442, or a reported overcharge. */
  priority?: "normal" | "high"; escalated_at?: string | null; escalated_by?: "customer" | "staff" | null;
};
/** complaint_escalations (0039): a customer's "Escalate to Nama 1442". */
export type ComplaintEscalation = { id: number; complaint_id: string; by_user: string | null; by_role: string; from_state: string; reason: string | null; created_at: string };
/** my_service_notices (0038): a live service-disruption notice for the caller's areas or sites. */
export type ServiceNotice = {
  id: string; title_en: string; title_ar: string; body_en: string; body_ar: string; severity: "info" | "warning" | "critical"; scope: "all" | "zones" | "clusters";
  starts_at: string; ends_at: string | null; areas: { en: string[]; ar: string[] }; sites: string[];
};
export type ComplaintNote = { id: number; complaint_id: string; author_id: string | null; author_role: string; body: string; internal: boolean; created_at: string };
export type Alert = { id: number; tanker_id: string | null; order_id: string | null; type: string; severity: "high" | "med" | "low"; message: string; lat: number | null; lng: number | null; state: "open" | "acknowledged" | "resolved"; created_at: string; acted_at: string | null; action_note: string | null };
export type Penalty = {
  id: string; penalty_no: number; rule_code: string; company_id: string | null; tanker_id: string | null; driver_id: string | null; order_id: string | null;
  customer_id: string | null; org_id: string | null; amount: string; reason: string; evidence: string; state: "issued" | "disputed" | "upheld" | "cancelled";
  dispute_text: string | null; created_at: string; decided_at: string | null;
};
export type PenaltyRule = { code: string; label: string; party: "driver" | "customer" | "business"; amount: string; amount_kind: "omr" | "pct"; compensation: string; active: boolean };
export type Notification = { id: number; user_id: string; event: string; channels: string[]; title: string; body: string; order_id: string | null; created_at: string; read_at: string | null };
export type NotificationTemplate = { event: string; label: string; audience: string; title_en: string; body_en: string; title_ar: string; body_ar: string; push: boolean; sms: boolean; whatsapp: boolean; email?: boolean; category?: "service" | "reminder" | "marketing"; critical?: boolean; message_class?: "transactional" | "marketing" };
export type Invoice = { id: string; invoice_no: number; org_id: string; period_start: string; period_end: string; orders: number; subtotal: string; vat: string; total: string; status: "issued" | "paid" | "overdue"; issued_at: string; due_at: string; paid_at: string | null;
  /** 0036: e-invoice (UBL / Fawtara) fields. */
  type_code?: string; currency?: string; seller_name?: string | null; seller_vatin?: string | null; buyer_name?: string | null; buyer_cr?: string | null; buyer_vatin?: string | null; vat_rate?: string | null;
};
export type TankerDocument = {
  id: string; tanker_id: string | null; driver_id: string | null; kind: string; ref_no: string; valid_to: string; file_path: string | null;
  status: "valid" | "pending_review" | "rejected"; uploaded_at: string;
  /** NWS's reason when the document was rejected (0024). */
  review_note?: string | null;
};
export type WaterTest = { id: string; tanker_id: string; cert_no: string; tested_at: string; chlorine: string; turbidity: string; tds: number; ph: string; ecoli: string; coliforms: string; passed: boolean };
export type Device = { id: string; tanker_id: string | null; firmware: string; sensors: Record<string, boolean>; installed_at: string };
export type Incident = { id: string; inc_no: number; priority: "P1" | "P2" | "P3" | "P4"; title: string; system: string; state: "open" | "acknowledged" | "resolved"; owner: string; notes: string; opened_at: string; acknowledged_at: string | null; resolved_at: string | null };
export type Integration = { key: string; name: string; purpose: string; status: "ok" | "warn" | "down" | "simulated"; last_test_at: string | null; latency_ms: number | null; note: string };
export type FraudFlag = { id: number; rule: string; subject_type: string; subject_id: string; details: string; score: number; state: "open" | "cleared" | "confirmed"; created_at: string };
export type DataRequest = { id: string; ref_no: number; customer_id: string | null; kind: "access" | "delete" | "correct"; details: string; state: "open" | "completed" | "rejected"; created_at: string; closed_at: string | null };
export type Promotion = { code: string; label: string; pct: string; audience: string; max_uses: number; uses: number; active: boolean; valid_to: string | null };
export type Inspection = { id: string; tanker_id: string; permit_id: string | null; inspector_id: string | null; result: "scheduled" | "pass" | "fail"; notes: string; checklist: Record<string, unknown>; scheduled_for: string | null; created_at: string };
export type OrderMessage = { id: number; order_id: string; sender_id: string | null; sender_role: "customer" | "driver" | "staff"; body: string; created_at: string; read_at?: string | null };

/** Display references for numbered records. */
export const ref = {
  order: (n: number | string) => `TO-${n}`,
  complaint: (n: number | string) => `C-${n}`,
  contract: (n: number | string) => `CT-${n}`,
  invoice: (n: number | string) => `INV-${n}`,
  penalty: (n: number | string) => `V-${n}`,
  incident: (n: number | string) => `INC-${n}`,
  payout: (n: number | string) => `PB-${n}`,
  dataRequest: (n: number | string) => `DSR-${n}`,
  // The customer's own PO number, labelled "PO …" unless it already says so ("PO-1234", "PO 77", "PO123").
  po: (s: string) => (/^\s*P\.?O(?![a-z])/i.test(s) ? s.trim() : `PO ${s.trim()}`),
};

/** One message per channel in the delivery pipeline (0026). The raw destination never leaves the database. */
export type OutboxRow = {
  id: number; notification_id: number | null; user_id: string | null; event: string; channel: "push" | "sms" | "whatsapp" | "email"; lang: "en" | "ar";
  destination_masked: string | null; title: string; body: string; status: "queued" | "sent" | "failed"; attempts: number; next_attempt_at: string;
  provider: string | null; provider_ref: string | null; provider_response: Record<string, unknown> | null; error: string | null;
  order_id: string | null; is_test: boolean; created_at: string; sent_at: string | null;
  /** 0038: transactional or marketing, and the SMS sender ID used. */
  message_class?: "transactional" | "marketing"; sender_id?: string | null;
};

/** dispatch_candidates (0026): a tanker ranked for an order, with the reasons. */
export type DispatchCandidate = {
  tanker_id: string; plate: string; driver_id: string | null; driver_name: string | null; company_name: string | null;
  distance_km: number | null; eta_min: number | null; jobs_today: number; rating: number | null; score: number;
  eligible: boolean; reasons: string[]; blockers: string[]; offered: boolean;
};

/** order_sla / my_order_sla (0026): the one on-time rule. */
export type OrderSla = {
  order_id: string; due_at: string; served_at: string | null; basis: "slot" | "asap"; asap_minutes: number; minutes_late: number;
  state: "on_time" | "late" | "on_track" | "at_risk" | "overdue" | "cancelled" | "not_started";
};
