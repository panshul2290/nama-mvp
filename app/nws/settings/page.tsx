"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loading } from "@/components/Shell";

export default function SettingsHome() {
  const router = useRouter();
  useEffect(() => router.replace("/nws/settings/users"), [router]);
  return <Loading />;
}
