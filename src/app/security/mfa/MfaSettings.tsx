"use client";

import { useActionState } from "react";
import Image from "next/image";
import { enrollTotpAction, verifyTotpAction, type MfaActionState } from "./actions";

const initialState: MfaActionState = {};

export function MfaSettings({
  verifiedFactor,
  isStepUp,
  nextPath,
}: {
  verifiedFactor?: { id: string; name: string };
  isStepUp: boolean;
  nextPath: string;
}) {
  const [enrollmentState, enroll, isEnrolling] = useActionState(enrollTotpAction, initialState);
  const [verificationState, verify, isVerifying] = useActionState(verifyTotpAction, initialState);
  const factorId = enrollmentState.factorId || verifiedFactor?.id;
  const isFactorVerified = Boolean(verifiedFactor);
  const codeState = verificationState.error ? verificationState : enrollmentState;

  return (
    <section className="mfa-panel">
      {isFactorVerified ? (
        <div className="mfa-factor-row">
          <span className="mfa-factor-icon" aria-hidden="true">✓</span>
          <span><strong>Authenticator aktif</strong><small>{verifiedFactor?.name || "TOTP"} · kode berubah setiap 30 detik</small></span>
          <span className="mfa-enabled-label">AKTIF</span>
        </div>
      ) : (
        <>
          <p className="mfa-explainer">
            {enrollmentState.message ||
              "Tambahkan faktor TOTP. Kunci pemulihan dan seed tidak dikirim ke NEON LAB; simpan secret secara aman di authenticator Anda."}
          </p>
          {enrollmentState.qrCode && enrollmentState.secret ? (
            <div className="mfa-enrollment">
              {/* Supabase returns this QR code as an SVG data URL for the user's authenticator. */}
              <Image
                className="mfa-qr"
                src={enrollmentState.qrCode}
                alt="QR code untuk mendaftarkan authenticator TOTP"
                width={190}
                height={190}
                unoptimized
              />
              <div className="mfa-secret-box">
                <span>Secret manual</span>
                <code>{enrollmentState.secret}</code>
              </div>
            </div>
          ) : (
            <form action={enroll}>
              <button className="auth-submit mfa-start-button" disabled={isEnrolling} type="submit">
                {isEnrolling ? "Menyiapkan..." : "Siapkan authenticator"}
              </button>
            </form>
          )}
        </>
      )}

      {factorId && (
        <form action={verify} className="mfa-verify-form">
          <input name="factorId" type="hidden" value={factorId} />
          <input name="next" type="hidden" value={nextPath} />
          <label className="auth-field">
            <span>{isStepUp ? "Kode untuk autentikasi ulang" : "Kode dari authenticator"}</span>
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={8}
              minLength={6}
              name="code"
              pattern="[0-9]{6,8}"
              placeholder="000000"
              required
              type="text"
            />
          </label>
          <button className="auth-submit" disabled={isVerifying} type="submit">
            {isVerifying ? "Memverifikasi..." : isStepUp ? "Verifikasi dan lanjutkan" : "Verifikasi MFA"}
          </button>
        </form>
      )}

      {codeState.error && <p className="auth-message auth-error" role="alert">{codeState.error}</p>}
      {verificationState.message && <p className="auth-message auth-success" role="status">{verificationState.message}</p>}
      {enrollmentState.message && !enrollmentState.qrCode && (
        <p className="auth-message auth-success" role="status">{enrollmentState.message}</p>
      )}
    </section>
  );
}
