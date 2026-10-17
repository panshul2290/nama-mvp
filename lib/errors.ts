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
  not_found: "Order not found.",
};

export function errorCode(error: { message?: string } | null | undefined): string | null {
  if (!error?.message) return null;
  return Object.keys(MESSAGES).find((code) => error.message!.includes(code)) ?? null;
}

export function friendlyError(error: { message?: string } | null | undefined): string {
  const code = errorCode(error);
  return code ? MESSAGES[code] : (error?.message ?? "Something went wrong.");
}
