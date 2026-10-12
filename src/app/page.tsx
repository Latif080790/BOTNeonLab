import { Suspense } from "react";
import DashboardClient from "./DashboardClient";
import { getDashboardIdentity } from "@/lib/auth/identity";

export default function HomePage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <AuthenticatedDashboard />
    </Suspense>
  );
}

async function AuthenticatedDashboard() {
  const identity = await getDashboardIdentity();
  return <DashboardClient identity={identity} />;
}

function DashboardLoading() {
  return (
    <main className="auth-page auth-loading" role="status" aria-live="polite">
      <div className="auth-page-glow" aria-hidden="true" />
      <span className="brand-mark"><span /></span>
      <p>Memuat identitas workspace…</p>
    </main>
  );
}
