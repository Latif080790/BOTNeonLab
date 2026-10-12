# NEON LAB

Prototype NEON LAB menggunakan Next.js, Supabase Auth, dan PostgreSQL Row Level Security. Isi Command Center saat ini tetap fixture demo; mengaktifkan login tidak mengaktifkan bot, koneksi bursa, atau alur dana.

## Menjalankan lokal

1. Untuk Supabase lokal, jalankan `supabase start` (memerlukan Docker), lalu `supabase db reset`. Untuk proyek hosted, jalankan `supabase link` lalu `supabase db push`, atau terapkan migrasi berurutan melalui SQL Editor:
   `supabase/migrations/20261012190000_workspace_identity.sql`
   `supabase/migrations/20261012194000_data_pipeline.sql`
   `supabase/migrations/20261012195000_market_discovery.sql`
   `supabase/migrations/20261012202000_market_universes.sql`
   Migrasi discovery aman dijalankan ulang jika enum `public.discovery_coverage` sudah ada dengan label yang sesuai; label yang berbeda akan menghentikan migrasi agar skema tidak tertimpa.
2. Pada proyek hosted, tambahkan URL callback deployment ke Authentication → URL Configuration → Redirect URLs, misalnya `https://<domain>/auth/callback`. URL localhost pengembangan sudah terdaftar di `supabase/config.toml`.
3. Buat variabel environment lokal:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key-dari-supabase-status>
   NEXT_PUBLIC_SITE_URL=http://localhost:3000
   ```

   Kunci `anon` lama dapat digunakan dengan nama `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Jangan menaruh `service_role`, secret key, kredensial venue, atau seed wallet di variabel `NEXT_PUBLIC_*`.

4. Pada hosted Supabase, set `NEXT_PUBLIC_SUPABASE_URL` ke URL proyek, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` ke publishable key, dan `NEXT_PUBLIC_SITE_URL` ke domain HTTPS deployment. Aktifkan TOTP MFA dan SMTP email terverifikasi sesuai kebutuhan produksi; layanan Auth hosted dapat mensyaratkan paket yang mendukung MFA. Supabase lokal mengirim email uji ke Inbucket.
5. Jalankan `npm run dev`.

Tanpa URL dan publishable/anon key yang valid, seluruh rute workspace tertutup dan halaman login menerangkan konfigurasi yang belum tersedia. Tidak ada akun demo bypass.

## Identitas dan otorisasi

- Supabase Auth menangani email/kata sandi, konfirmasi email, sesi cookie server, dan faktor MFA TOTP.
- Proxy menyegarkan sesi sebelum halaman terproteksi; komponen server hanya membaca cookie, sedangkan Server Actions/Route Handlers diberi jalur penulisan cookie secara eksplisit.
- Trigger database membuat profil, workspace personal, keanggotaan, dan role `owner` setelah pembuatan user Auth berhasil. Metadata nama diverifikasi batas panjangnya dan tidak menjadi sumber otorisasi.
- `memberships` mencatat keanggotaan; `membership_roles` menyimpan role terpisah agar satu user dapat memiliki beberapa role pada workspace yang sama.
- Role workspace: `owner`, `researcher`, `operator`, `risk_approver`, `auditor`, dan `platform_admin`. Role baru tidak dapat diberikan oleh klien; provisioner berprivilege harus memvalidasi grant di sisi server.
- Semua tabel identitas dan registry akun mengaktifkan RLS. Helper role `SECURITY DEFINER` menggunakan `search_path` kosong dan query terkualifikasi untuk mencegah rekursi policy.
- Registry `execution_accounts` hanya menyimpan identitas akun tanpa kredensial. Tabel eksekusi berikutnya harus membawa `workspace_id` dan mereferensikan akun menggunakan FK gabungan `(workspace_id, account_id)`.
- Audit perubahan identitas dibuat oleh trigger database. Event hanya dapat dibaca oleh Owner/Auditor dalam workspace terkait atau aktor event; role `authenticated` tidak mendapat izin mengubah atau menghapus log.
- Provisioning akun mencatat actor auth baru; setiap provisioner privileged berikutnya wajib mengikat identity actor dan reason ke konteks audit transaksi.
- Operasi sensitif masa depan wajib memanggil `requireWorkspaceRole` dan `requireStepUpAuthentication` di server serta tetap tunduk pada RLS. UI bukan kontrol otorisasi.
- MFA TOTP dapat diatur dari tautan keamanan akun. Supabase Auth mengelola secret faktor; NEON LAB tidak menyimpan password authenticator. Gunakan assurance `aal2` untuk jalur step-up.

## Data pipeline — tahap awal E03

- `GET /api/market/search?q=<query>` melakukan pencarian publik DEX Screener hanya untuk sesi terautentikasi dengan role `owner`, `researcher`, atau `operator`. Endpoint provider dikunci di server; input tidak dapat menentukan URL tujuan.
- `GET /api/market/discoveries?limit=50&cursor=<opaque>` membaca observasi discovery tersimpan secara keyset-paginated dalam workspace pengguna. Cursor terikat ke workspace dan urutan tetap memakai `observed_at` serta ID; hasil tetap hanya bukti discovery, bukan feed harga eksekusi.
- `GET /api/market/universes?limit=50&cursor=<opaque>` menampilkan revisi universe terbaru per nama dengan cursor keyset terikat workspace. `POST /api/market/universes` membuat revisi immutable baru; pemohon wajib memiliki role owner, researcher, atau operator dan menyertakan provider terdaftar, cakupan venue/chain, referensi lisensi, batas kandidat, serta status.
- Registry universe mencatat cakupan dan batas halaman, tetapi bukan allowlist trading. Route crawler/provider belum mengonsumsi universe tersebut; jangan menganggap keberadaan revisi `active` sebagai izin trading atau klaim coverage.
- Kuota API dibedakan per endpoint berdasarkan [dokumentasi DEX Screener](https://docs.dexscreener.com/api/reference.md) dan dicadangkan atomik dalam rolling window PostgreSQL bersama antar-instance. Hanya GET idempoten yang dicoba ulang, maksimal tiga attempt dan dalam deadline terbatas; kegagalan tetap dikembalikan eksplisit.
- Identitas DEX menggunakan chain, mint, dan pool tanpa mengubah kapitalisasi alamat; identitas CEX memuat venue, market type, base, quote, dan symbol. Instrumen bersimbol sama tidak digabung lintas identitas.
- Hasil search dicap `PARTIAL` dan `tradingEligible: false`. DEX Screener tidak menyediakan waktu event atau sequence pada endpoint pencarian; waktu respons tidak menggantikan waktu pasar. Quality gate karena itu menandai hasil `needs_data`, sehingga hasil discovery ini tidak layak menjadi quote eksekusi atau input keputusan trading.
- Run pencarian dan kandidat disimpan append-only secara atomik melalui RPC yang memvalidasi actor, workspace, role, schema dan hash; query asli tidak disimpan, hanya hash SHA-256. Baca data discovery tunduk pada membership RLS dan FK komposit menjaga kandidat tetap dalam workspace run induk.
- Migrasi menyiapkan `market_events` append-only dan `provider_states`. Penulisan keduanya disediakan hanya bagi collector tepercaya dengan service role; API web tidak menyimpan atau memalsukan event pasar lewat publishable key. Durable market ingestion belum diaktifkan sampai worker tepercaya dan kebijakan penyimpanan provider dibangun.
- Evaluator SCAN deterministik mensyaratkan policy berversi, seluruh metrik yang diperlukan, snapshot segar, sequence terurut tanpa gap dan dua source lineage independen. Snapshot hilang/stale menghasilkan `NEEDS_DATA`; threshold belum ditetapkan di endpoint ini, sehingga tidak ada policy trading default.
- Endpoint `/latest/dex/search` saat ini merupakan vertical slice discovery, bukan crawler penuh: belum ada universe/cursor, adapter CEX, pemilihan pool canonical/watchlist, API scan yang memakai policy tersimpan, atau feed quote/order-book eksekusi.

## Pengujian

Jalankan pemeriksaan proyek dengan:

```bash
npm run lint
npm run build
```

Setelah Supabase lokal aktif dan migrasi diterapkan, validasi policy serta fungsi database dengan:

```bash
supabase db lint --local
```

Pengujian integrasi RLS/Auth memerlukan proyek Supabase dan migrasi yang diterapkan. Build atau pemeriksaan dokumen saja tidak membuktikan kesiapan atau keselamatan LIVE.
