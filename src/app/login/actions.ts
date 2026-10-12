"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createSupabaseActionClient } from "@/lib/supabase/server";
import { getPublicSiteUrl } from "@/lib/supabase/config";

export type AuthFormState = {
  error?: string;
  message?: string;
};

const signInSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
  next: z.string().optional(),
});

const signUpSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).max(128),
});

function getSafeReturnPath(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

export async function signInAction(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") || undefined,
  });

  if (!parsed.success) {
    return { error: "Masukkan email yang valid dan kata sandi." };
  }

  const supabase = await createSupabaseActionClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    if (error.status === 429) {
      return { error: "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi." };
    }
    return { error: "Email atau kata sandi tidak valid, atau email belum dikonfirmasi." };
  }

  redirect(getSafeReturnPath(parsed.data.next));
}

export async function signUpAction(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      error: "Isi nama 2–80 karakter, email valid, dan kata sandi minimal 12 karakter.",
    };
  }

  const supabase = await createSupabaseActionClient();
  const siteUrl = getPublicSiteUrl();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${siteUrl}/auth/callback?next=%2F`,
      data: { display_name: parsed.data.displayName },
    },
  });

  if (error) {
    if (error.status === 429) {
      return { error: "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi." };
    }
    return { error: "Pendaftaran belum berhasil. Periksa data dan konfigurasi Auth, lalu coba lagi." };
  }

  if (data.session) {
    redirect("/");
  }

  return {
    message: "Jika email dapat didaftarkan, tautan konfirmasi telah dikirim. Periksa kotak masuk Anda.",
  };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseActionClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error("Unable to end the current session.");
  }
  redirect("/login");
}
