"use client";

// NWS → Two-step sign-in (0052, security review SEC-06): every staff member can add or remove an
// authenticator app for their own account; admins decide whether it is required (STAFF_MFA).
import { MfaPanel } from "@/components/nws/StaffMfa";
import { useStaff } from "@/components/nws/StaffContext";

export default function SecurityPage() {
  const { staff, toast } = useStaff();
  return <MfaPanel isAdmin={staff.staff_role === "admin"} toast={toast} />;
}
