import type { ServiceType } from "./pricing";

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
  service_type: ServiceType;
  gallons: number;
  area: string;
  distance_km: number;
  driver_earnings: string;
  created_at: string;
};

export type LngLat = { lat: number; lng: number };
