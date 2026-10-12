"use client";

import { useActionState, useState } from "react";
import { signInAction, signUpAction, type AuthFormState } from "./actions";

const initialState: AuthFormState = {};

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [signInState, signIn, isSigningIn] = useActionState(signInAction, initialState);
  const [signUpState, signUp, isSigningUp] = useActionState(signUpAction, initialState);
  const state = isSignUp ? signUpState : signInState;
  const isPending = isSignUp ? isSigningUp : isSigningIn;

  return (
    <section className="auth-card">
      <div className="auth-card-header">
        <span className="auth-card-mark" aria-hidden="true"><span /></span>
        <p className="eyebrow">AKSES WORKSPACE</p>
        <h1>{isSignUp ? "Buat workspace pribadi" : "Selamat datang kembali"}</h1>
        <p>
          {isSignUp
            ? "Akun baru akan memperoleh workspace personal. Keanggotaan tim hanya dapat diberikan melalui jalur administrator."
            : "Masuk untuk melihat workspace dan data demo Anda."}
        </p>
      </div>

      <div className="auth-tabs" role="tablist" aria-label="Jenis autentikasi">
        <button
          type="button"
          role="tab"
          aria-selected={!isSignUp}
          className={!isSignUp ? "auth-tab active" : "auth-tab"}
          onClick={() => setIsSignUp(false)}
        >
          Masuk
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isSignUp}
          className={isSignUp ? "auth-tab active" : "auth-tab"}
          onClick={() => setIsSignUp(true)}
        >
          Daftar
        </button>
      </div>

      <form action={isSignUp ? signUp : signIn} className="auth-form">
        {isSignUp && (
          <label className="auth-field">
            <span>Nama tampilan</span>
            <input
              autoComplete="name"
              maxLength={80}
              minLength={2}
              name="displayName"
              required
              type="text"
            />
          </label>
        )}
        <label className="auth-field">
          <span>Email</span>
          <input
            autoComplete="email"
            autoCapitalize="none"
            maxLength={254}
            name="email"
            placeholder="nama@domain.com"
            required
            type="email"
          />
        </label>
        <label className="auth-field">
          <span>Kata sandi</span>
          <input
            autoComplete={isSignUp ? "new-password" : "current-password"}
            maxLength={128}
            minLength={isSignUp ? 12 : 1}
            name="password"
            required
            type="password"
          />
          {isSignUp && <small>Minimal 12 karakter. Gunakan kata sandi unik.</small>}
        </label>

        {!isSignUp && <input name="next" type="hidden" value={nextPath} />}

        {state.error && <p className="auth-message auth-error" role="alert">{state.error}</p>}
        {state.message && <p className="auth-message auth-success" role="status">{state.message}</p>}

        <button className="auth-submit" disabled={isPending} type="submit">
          {isPending ? "Memproses..." : isSignUp ? "Buat akun dan workspace" : "Masuk ke workspace"}
        </button>
      </form>

      <p className="auth-security-note">
        <span aria-hidden="true">◈</span> Dilindungi sesi Supabase Auth dan isolasi data berbasis RLS.
      </p>
    </section>
  );
}
