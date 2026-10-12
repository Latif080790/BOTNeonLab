# E03 — laporan implementasi dan verifikasi

Sesi: 12 Oktober 2026. Status keseluruhan: **IN_PROGRESS — migration history dan schema hosted sudah direkonsiliasi; verifikasi end-to-end hosted dan konfigurasi worker masih menunggu**.

## Hasil implementasi

- API authenticated untuk enqueue crawl dan membaca status/observasi, dengan pemeriksaan origin, role dan RLS.
- Akuisisi manual dari seed pencarian yang disimpan, terikat universe revision, chain/venue, lisensi referensi dan batas kandidat.
- Antrean durable, attempt yang bertahan lintas restart, lease fencing, deadline 30 detik dan maksimum tiga attempt.
- Quota rolling window serta backoff bersama jalur web/worker; snapshot quota limit/remaining ikut disimpan.
- Commit atomik hasil, observasi market_events, provider state dan outbox. Dedupe per logical run dan instrumen; retry finish identik tidak memposting ulang.
- Identitas observation internal terpisah dari source_event_id yang tidak disediakan search.
- Worker server-only dengan RPC khusus service role, timeout, body limit, fixed provider URL dan tanpa retry SDK tersembunyi.
- Panduan operasional, skenario SQL rollback dan suite pengujian yang dapat dijalankan ulang.

## Bukti pengujian

| Pemeriksaan | Hasil yang diamati |
| --- | --- |
| Unit/domain/transport (`npm test`) | 9 kasus PASS: identitas, SCAN dasar, schema, deadline, retry, ukuran body dan DB failure |
| Auth dan database lokal (`npm run test:integration`) | 2 kasus PASS, termasuk banyak assertion RLS, RPC, idempotensi, outbox dan 12 worker paralel berebut satu sisa kuota |
| HTTP aplikasi dengan cookie login nyata (`npm run test:routes`) | 1 kasus PASS: origin asing 403, enqueue 202, hasil 200, status PARTIAL dan tradingEligible false |
| SQL transaksional (`supabase/tests/market_crawler.sql`) | PASS: percobaan ketiga berhasil, crash/reclaim, worker lama ditolak, rollback seluruh hasil bila item kedua invalid, quota bersama, Retry-After, perubahan universe, pencabutan role dan RLS; fixture di-rollback |
| Provider nyata (`scripts/check-dex-provider.mts`) | Satu pencarian read-only berhasil; 27 observasi, seluruh quality needs_data; tidak menulis database atau mengirim order |
| SQL lint lokal | Tidak ditemukan kesalahan schema/function |
| TypeScript, ESLint, build produksi | PASS |
| Whitespace diff | PASS |
| Hosted migration history | PASS: delapan versi, `20261012190000` sampai `20261013012001`, tercatat setelah repair migration history yang sebelumnya kosong |
| Hosted schema inventory | PASS: 573 entri dibandingkan dengan database lokal hasil migrasi; tidak ada entri missing, extra atau berbeda |
| Hosted crawl state saat pemeriksaan | 0 run, 0 discovery run, 0 universe, dan 0 crawl aktif |
| Hosted authenticated crawl end-to-end | **NOT RUN** — belum ada sesi/uji universe hosted yang disiapkan; tidak membuat data, pengguna atau kriteria scope dengan asumsi |
| Hosted security advisors | WARN: SECURITY DEFINER RPC yang memang memerlukan otorisasi server/database dan proteksi password bocor Auth yang masih nonaktif |

Pengujian HTTP memakai provider fixture; pengujian provider nyata dilakukan terpisah. Kombinasi keduanya belum merupakan bukti pengoperasian worker hosted. Data fixture berada di database lokal terisolasi; credentials dan `.env.local` hosted tidak diubah. Output 27 observasi adalah hasil satu smoke check, bukan jaminan jumlah hasil provider berikutnya.

## Temuan yang diperbaiki selama pengujian

1. SQLSTATE 40001 untuk konflik domain membuat lapisan API mengulang transaksi. Konflik domain sekarang memakai PT409; 40001 tidak dipakai sebagai kode worker kedaluwarsa.
2. Hash hasil sama pada attempt berikutnya sempat berpotensi dianggap replay. Replay sekarang hanya diizinkan pada state non-running dengan token lease hasil yang sama; uji dua kegagalan identik lalu sukses ketiga membuktikan budget tetap benar.
3. Body provider tanpa field pairs sebelumnya dapat dianggap hasil kosong. Payload tersebut sekarang gagal schema; array kosong yang sah tetap PARTIAL.
4. Kuota web dan worker memakai lock/ledger yang sama serta menghormati backoff yang sama. Trigger menyimpan snapshot kuota tanpa menganggapnya izin request berikutnya.

## Keadaan hosted yang benar-benar teramati

Proyek pada konfigurasi aplikasi adalah BOTNeonLab, ref `zgjgkdwsolldzvhifjhh`. Awalnya history migration hosted kosong walau objek schema sudah dipasang manual. Inventory dibandingkan dengan migrasi lokal; function fingerprint mencocokkan versi dasar yang sudah ada dan menunjukkan hardening/observability/reconciliation sebagai selisih yang belum terpasang. Hosted memiliki 0 run, discovery run, universe dan crawl aktif saat diperiksa.

Lima migration yang schema-nya telah terbukti cocok ditandai applied tanpa mengulang DDL: `20261012190000`, `20261012194000`, `20261012195000`, `20261012202000`, dan `20261013010000`. Setelah itu `supabase db push --linked` berhasil menerapkan tiga migration tertunda: `20261013011000`, `20261013012000`, dan `20261013012001`. Query read-only sesudah penerapan mengonfirmasi delapan versi tercatat. Inventory hosted sesudahnya identik dengan inventory fresh local (573 entri); tidak ada migration reset atau perubahan data hosted yang diminta.

CLI `migration list` kemudian gagal memakai login role database karena autentikasi password role CLI, tetapi migration history berhasil diverifikasi melalui query hosted read-only lewat Management API. Kegagalan itu tidak membatalkan hasil `db push` maupun query history.

## Pekerjaan yang masih diperlukan untuk menutup E03

1. Verifikasi hosted authenticated route/RLS dan satu crawl fixture yang diotorisasi, dengan universe, seed dan penanganan data uji yang disetujui pemilik workspace; sampai itu dilakukan, jangan anggap worker hosted aktif.
2. Konfigurasikan worker dengan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` melalui environment server/secret manager. Jangan menaruh key privileged di variabel `NEXT_PUBLIC_*` atau mengirimkannya lewat chat.
3. Tinjau warning security advisor: SECURITY DEFINER RPC memiliki grant authenticated yang disengaja dan pemeriksaan role internal; leaked-password protection Auth perlu dipertimbangkan untuk diaktifkan.
4. Catat reviewer/pemilik hasil, sepakati batas scope E03 search-discovery, lalu lanjutkan E04 untuk SCAN lengkap, VET dan watchlist.

Capability pagination/enumerasi DEX Screener search tetap tidak diklaim. Kontrak `discovery-observation-v1` adalah kontrak internal E03 terbatas, bukan klaim seluruh B01 2.0/PRD telah diimplementasikan. Perubahan major kontrak bot bersama dan feed trading memerlukan pekerjaan/validasi tersendiri.

Panduan penggunaan: [E03 crawler](e03-crawler.md).
