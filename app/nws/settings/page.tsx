"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { homeFor, settingsFor } from "@/components/nws/access";
import { useStaff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";

// Settings opens on the first page the role may use (Finance → Payments, operators → Emergency mode).
export default function SettingsHome() {
  const router = useRouter();
  const { staff } = useStaff();
  useEffect(() => {
    const list = settingsFor(staff.staff_role);
    const pick = staff.staff_role === "admin" ? list[0] : (list.find((p) => p.endsWith("/payments")) ?? list.find((p) => p.endsWith("/emergency")) ?? list[0]);
    router.replace(pick ?? homeFor(staff.staff_role));
  }, [router, staff.staff_role]);
  return <Loading />;
}
