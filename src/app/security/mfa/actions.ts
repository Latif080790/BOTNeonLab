"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseActionClient } from "@/lib/supabase/server";

export type MfaActionState = {
  error?: string;
  message?: string;
  factorId?: string;
  qrCode?: string;
  secret?: string;
};

const verificationSchema = z.object({
  factorId: z.uuid(),
  code: z.string().trim().regex(/^\d{6,8}$/),
  next: z.string().optional(),
});

function getSafeReturnPath(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

export async function enrollTotpAction(
  previousState: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  void previousState;
  void formData;
  const supabase = await createSupabaseActionClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError && (claimsError.status === undefined || claimsError.status === 0 || claimsError.status >= 500)) {
    return { error: "Layanan autentikasi tidak tersedia. Coba lagi nanti." };
  }
  if (!claims?.claims?.sub) {
    return { error: "Sesi berakhir. Masuk kembali untuk mengaktifkan MFA." };
  }

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) {
    return { error: "Faktor MFA tidak dapat diperiksa. Coba lagi nanti." };
  }

  const verifiedFactor = factors.totp.find((factor) => factor.status === "verified");
  if (verifiedFactor) {
    return {
      factorId: verifiedFactor.id,
      message: "MFA TOTP sudah aktif pada akun ini. Masukkan kode untuk memverifikasi.",
    };
  }

  for (const factor of factors.totp) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      return { error: "Pendaftaran MFA sebelumnya tidak dapat dibersihkan. Hubungi administrator." };
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "NEON LAB Authenticator",
  });
  if (error) {
    return { error: "MFA tidak dapat dimulai. Periksa konfigurasi Auth dan coba lagi." };
  }

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    message: "Pindai QR dengan aplikasi authenticator, lalu masukkan kode verifikasi.",
  };
}

export async function verifyTotpAction(
  _previousState: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  const parsed = verificationSchema.safeParse({
    factorId: formData.get("factorId"),
    code: formData.get("code"),
    next: formData.get("next") || undefined,
  });
  if (!parsed.success) {
    return { error: "Masukkan kode authenticator 6–8 digit yang valid." };
  }

  const supabase = await createSupabaseActionClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError && (claimsError.status === undefined || claimsError.status === 0 || claimsError.status >= 500)) {
    return { error: "Layanan autentikasi tidak tersedia. Coba lagi nanti." };
  }
  if (!claims?.claims?.sub) {
    return { error: "Sesi berakhir. Masuk kembali untuk melanjutkan." };
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) {
    return { error: "Kode tidak valid atau sudah kedaluwarsa. Coba kode terbaru." };
  }

  revalidatePath("/", "layout");
  const returnPath = getSafeReturnPath(parsed.data.next);
  redirect(returnPath === "/security/mfa" ? "/security/mfa?status=enabled" : returnPath);
}
