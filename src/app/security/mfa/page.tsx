import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MfaSettings } from "./MfaSettings";

export const metadata: Metadata = {
  title: "Keamanan MFA | NEON LAB",
  description: "Pengaturan authenticator TOTP dan autentikasi ulang.",
};

type MfaPageProps = {
  searchParams: Promise<{ next?: string; status?: string }>;
};

function safeReturnPath(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

export default function MfaPage({ searchParams }: MfaPageProps) {
  return (
    <Suspense fallback={<MfaLoading />}>
      <MfaContent searchParams={searchParams} />
    </Suspense>
  );
}

async function MfaContent({ searchParams }: MfaPageProps) {
  const params = await searchParams;
  const nextPath = safeReturnPath(params.next);
  const isStepUp = Boolean(params.next && nextPath !== "/security/mfa");
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    redirect("/login");
  }

  const { data: factorData, error: factorError } = await supabase.auth.mfa.listFactors();
  if (factorError) {
    throw new Error("Unable to load the account's MFA configuration.");
  }

  const verifiedFactor = factorData.totp.find((factor) => factor.status === "verified");

  return (
    <main className="auth-page">
      <div className="auth-page-glow" aria-hidden="true" />
      <Link className="auth-brand" href="/" aria-label="NEON LAB">
        <span className="brand-mark"><span /></span>
        <span className="brand-copy"><strong>NEON<span>LAB</span></strong><small>TRADING CONTROL</small></span>
      </Link>
      <section className="auth-card mfa-card">
        <div className="auth-card-header">
          <span className="auth-card-mark" aria-hidden="true">◈</span>
          <p className="eyebrow">{isStepUp ? "STEP-UP AUTHENTICATION" : "KEAMANAN AKUN"}</p>
          <h1>{isStepUp ? "Konfirmasi identitas" : "Autentikasi multifaktor"}</h1>
          <p>
            {isStepUp
              ? "Tindakan berikut memerlukan sesi MFA terbaru. Masukkan kode authenticator Anda."
              : "TOTP menambah lapisan verifikasi. Pengaktifan fitur sensitif akan memerlukan assurance level MFA."}
          </p>
        </div>
        {params.status === "enabled" && (
          <p className="auth-message auth-success" role="status">
            MFA TOTP berhasil diverifikasi dan diaktifkan.
          </p>
        )}
        <MfaSettings
          verifiedFactor={
            verifiedFactor
              ? { id: verifiedFactor.id, name: verifiedFactor.friendly_name || "Authenticator TOTP" }
              : undefined
          }
          isStepUp={isStepUp}
          nextPath={isStepUp ? nextPath : "/security/mfa"}
        />
        <Link className="auth-back-link" href="/">Kembali ke Command Center</Link>
      </section>
      <p className="auth-page-footer">NEON LAB · Faktor TOTP dikelola oleh Supabase Auth</p>
    </main>
  );
}

function MfaLoading() {
  return (
    <main className="auth-page auth-loading" role="status" aria-live="polite">
      <div className="auth-page-glow" aria-hidden="true" />
      <span className="brand-mark"><span /></span>
      <p>Memuat pengaturan keamanan…</p>
    </main>
  );
}
