"use client";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card auth-setup-card" role="alert">
        <div className="auth-card-header">
          <span className="auth-card-mark auth-mark-warning" aria-hidden="true">!</span>
          <p className="eyebrow">IDENTITAS WORKSPACE</p>
          <h1>Data akun tidak dapat dimuat</h1>
          <p>Sesi tetap dilindungi. Periksa konfigurasi Auth, migrasi database, atau akses workspace lalu coba lagi.</p>
        </div>
        <div className="auth-error-actions">
          <button className="auth-submit" onClick={reset} type="button">Coba lagi</button>
          <a className="auth-back-link" href="/login">Kembali ke halaman masuk</a>
        </div>
      </section>
    </main>
  );
}
