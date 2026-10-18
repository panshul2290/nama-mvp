import type { RuleStatus, ServiceType } from "./pricing";

export type Role = "customer" | "driver";

export type OrderStatus = "requested" | "accepted" | "arriving" | "arrived" | "delivered" | "cancelled";

export const ACTIVE_STATUSES: OrderStatus[] = ["requested", "accepted", "arriving", "arrived"];

export type Profile = {
  id: string;
  role: Role;
  full_name: string;
  phone: string | null;
};

export type Tanker = {
  driver_id: string;
  plate: string;
  service_type: ServiceType;
  capacity_gal: number;
  is_online: boolean;
  last_lat: number | null;
  last_lng: number | null;
  last_seen_at: string | null;
};

export type Order = {
  id: string;
  /** Sequential, server-assigned; display as TO-<order_no>. */
  order_no: number;
  customer_id: string;
  driver_id: string | null;
  service_type: ServiceType;
  gallons: number;
  area: string;
  water_charge: string;
  delivery_fee: string;
  vat: string;
  total: string;
  driver_earnings: string;
  status: OrderStatus;
  /** Status of the pricing rules behind each line when the order was priced. */
  price_basis: { water: RuleStatus; fee: RuleStatus; vat: RuleStatus; total: RuleStatus; earnings: RuleStatus; rules: string[]; mode: string } | null;
  driver_name: string | null;
  tanker_plate: string | null;
  created_at: string;
  accepted_at: string | null;
  arriving_at: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
};

export type OrderLocation = { order_id: string; lat: number; lng: number; address: string };

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
};

export type LngLat = { lat: number; lng: number };
