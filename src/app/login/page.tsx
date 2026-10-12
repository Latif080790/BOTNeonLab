import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "./LoginForm";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "Masuk | NEON LAB",
  description: "Autentikasi dan akses workspace NEON LAB.",
};

type LoginPageProps = {
  searchParams: Promise<{ next?: string; error?: string }>;
};

function safeReturnPath(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  return (
    <Suspense fallback={<AuthLoading />}>
      <LoginContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginContent({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const supabaseConfigured = Boolean(getSupabasePublicConfig());

  return (
    <main className="auth-page">
      <div className="auth-page-glow" aria-hidden="true" />
      <Link className="auth-brand" href="/" aria-label="NEON LAB">
        <span className="brand-mark"><span /></span>
        <span className="brand-copy"><strong>NEON<span>LAB</span></strong><small>TRADING CONTROL</small></span>
      </Link>
      {!supabaseConfigured ? (
        <section className="auth-card auth-setup-card" role="alert">
          <div className="auth-card-header">
            <span className="auth-card-mark auth-mark-warning" aria-hidden="true">!</span>
            <p className="eyebrow">AUTENTIKASI BELUM DIKONFIGURASI</p>
            <h1>Akses ditutup</h1>
            <p>Supabase Auth belum disiapkan. Dashboard tidak dibuka dengan akun atau data demo bawaan.</p>
          </div>
          <ol className="auth-setup-steps">
            <li>Isi <code>NEXT_PUBLIC_SUPABASE_URL</code> dan <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.</li>
            <li>Terapkan migrasi identitas dari folder <code>supabase/migrations</code>.</li>
            <li>Atur URL situs dan redirect konfirmasi email Supabase.</li>
          </ol>
        </section>
      ) : (
        <>
          {params.error === "configuration" && (
            <p className="auth-message auth-error auth-global-message" role="alert">
              Supabase belum terkonfigurasi lengkap. Akses workspace tetap diblokir.
            </p>
          )}
          {params.error === "verification" && (
            <p className="auth-message auth-error auth-global-message" role="alert">
              Tautan konfirmasi tidak valid atau kedaluwarsa. Masuk kembali atau minta tautan konfirmasi baru.
            </p>
          )}
          <LoginForm nextPath={safeReturnPath(params.next)} />
        </>
      )}
      <p className="auth-page-footer">NEON LAB · Akses aman untuk workspace Anda</p>
    </main>
  );
}

function AuthLoading() {
  return (
    <main className="auth-page auth-loading" role="status" aria-live="polite">
      <div className="auth-page-glow" aria-hidden="true" />
      <span className="brand-mark"><span /></span>
      <p>Memuat halaman masuk…</p>
    </main>
  );
}
