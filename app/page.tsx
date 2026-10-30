import { Launcher } from "@/components/portal/Launcher";

// The launcher lists the apps. Each app keeps its own session and checks it itself
// (a signed-in app's sign-in page opens the app), so nothing is forwarded from here.
export default function Home() {
  return <Launcher />;
}
