// Maps the stable error codes raised by the database RPCs to UI copy.
const MESSAGES: Record<string, string> = {
  already_taken: "Already taken — another driver accepted this job first.",
  not_eligible: "This request doesn't match your tanker's type or capacity.",
  driver_busy: "Finish your current job before accepting another.",
  driver_offline: "Go online to accept jobs.",
  not_a_driver: "Only drivers with a registered tanker can do this.",
  not_a_customer: "Only customer accounts can place orders.",
  cannot_cancel: "A driver has already accepted this order, so it can't be cancelled.",
  invalid_transition: "That step isn't available for this job right now.",
  invalid_gallons: "Enter a volume between 1 and 20,000 gallons.",
  invalid_location: "Pick a delivery location on the map.",
  area_required: "Enter the area or neighbourhood.",
  not_found: "Not found.",
  no_tanker: "No tanker is assigned to you. Ask your company or NWS to assign one.",
  already_assigned: "You already have a tanker assigned.",
  plate_taken: "That plate is already registered.",
  tanker_blocked: "Your tanker is blocked by NWS, so it can’t go online or take jobs.",
  permit_invalid: "Your tanker has no approved, valid permit for its service, so it can’t go online or take jobs.",
  not_staff: "Only NWS staff can do this.",
  forbidden_for_role: "Your staff role doesn’t allow this action.",
  reason_required: "Please give a reason (at least 3 characters).",
  already_blocked: "This tanker is already blocked.",
  not_blocked: "This tanker isn’t blocked.",
  tanker_on_job: "This tanker is on a job; finish or reassign the job first.",
  driver_already_assigned: "That driver already has a tanker.",
  tanker_already_assigned: "That tanker already has a driver.",
  not_assigned: "This tanker has no driver assigned.",
  invalid_state: "That isn’t possible in the permit’s current state.",
  invalid_dates: "The expiry date must be after the issue date.",
  permit_no_taken: "That permit number already exists.",
  cannot_change_own_role: "You can’t change your own role.",
  target_is_driver: "Drivers can’t be made staff.",
  pricing_unconfirmed: "This order can’t be priced yet: some pricing rules are still awaiting NWS confirmation (billing is in production mode).",
  price_immutable: "Prices can’t be changed after an order is placed.",
};

export function errorCode(error: { message?: string } | null | undefined): string | null {
  if (!error?.message) return null;
  return Object.keys(MESSAGES).find((code) => error.message!.includes(code)) ?? null;
}

export function friendlyError(error: { message?: string } | null | undefined): string {
  const code = errorCode(error);
  return code ? MESSAGES[code] : (error?.message ?? "Something went wrong.");
}
