# E03 — crawler dan ingestion terbatas

## Cakupan

Implementasi menyediakan pekerjaan manual berizin, antrean database durable, worker terpisah, quota bersama, ingestion observasi, status provider dan outbox. Adapter saat ini hanya DEX Screener search; tidak mengklaim enumerasi semua token. SCAN lengkap, VET/watchlist dan feed eksekusi tetap di epic berikutnya.

Satu pekerjaan = satu seed pencarian pada satu revisi universe. Seed disimpan bersama run untuk replay input permintaan; input bukan URL bebas. Tidak ada scheduler pencarian otomatis yang mengarang seed dari nama chain. Worker berjalan terus untuk memproses antrean yang sudah diterima.

## Migrasi

Terapkan migrasi berurutan termasuk:

- `20261012202000_market_universes.sql`
- `20261013010000_market_crawler.sql`
- `20261013011000_market_crawler_hardening.sql`
- `20261013012000_market_quota_observability.sql`
- `20261013012001_reconcile_discovery_schema.sql`

Jika migrasi pernah dijalankan melalui SQL Editor, bandingkan schema, function, grant, policy, trigger dan constraint sebelum memperbaiki migration history. Jangan menjalankan ulang `CREATE TABLE` atau melakukan reset hosted. Hardening menggunakan `PT409` untuk konflik domain agar PostgREST tidak mengulangnya sebagai serialization failure.

## API

`POST /api/market/crawls` memakai sesi login cookie. Role owner/researcher/operator diperiksa lagi oleh RPC. Origin browser harus sama dengan origin aplikasi. Body:

```json
{
  "workspaceId": "UUID workspace pengguna",
  "universeId": "UUID universe aktif",
  "universeRevision": 1,
  "query": "SOL/USDC",
  "idempotencyKey": "UUID baru untuk satu permintaan logis"
}
```

Workspace ID yang diperlukan pada body dapat dibaca dari properti `workspaceId` pada respons `GET /api/market/universes`; nilainya selalu milik workspace pertama yang diotorisasi untuk sesi aktif.

Universe harus hanya memuat provider `dexscreener`, memiliki license reference dan minimal batas chain atau venue. Jika kedua batas terisi, kandidat harus memenuhi keduanya. Pemilihan chain/venue merupakan filter hasil, bukan jaminan endpoint provider membatasi pencarian pada scope tersebut.

Respons 202 memuat runId dan statusUrl; klien melakukan `GET /api/market/crawls/{runId}` untuk status dan observasi. RLS menolak pembacaan lintas workspace. Maksimal 500 observasi; tidak ada pagination provider. UUID/hash adalah identitas, bukan bukti kelengkapan pasar.

Key sama dengan input sama mengembalikan run yang sama; input berbeda menghasilkan 409. Permintaan lain untuk input sama ketika run masih aktif juga menghasilkan 409. Poll berikutnya setelah run terminal memakai key baru. Saat respons enqueue hilang, ulangi key yang sama, jangan membuat run baru.

## Worker

Worker tidak memakai cookie pengguna atau membaca `.env.local` secara otomatis. Runtime worker harus menyediakan dua variabel server-only melalui secret manager/deployment environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Jalankan `npm run worker:market`; untuk satu iterasi gunakan `npm run worker:market -- --once`. Node 24 digunakan dalam validasi. Kunci tidak boleh memakai prefix `NEXT_PUBLIC_`, dikirim ke browser, atau ditulis dalam log. Karena service role berprivilege, worker harus terpisah dari bundel/rute web. RPC claim/finish tidak dapat dipanggil pengguna authenticated atau anon.

Worker memanggil claim atomik dengan ID worker. Database memeriksa role pemohon saat claim, revisi universe, quota dan backoff. Setiap fetch dicatat sebagai attempt sebelum I/O; lease 10 detik dan I/O maksimum 5 detik berada dalam deadline job 30 detik sejak enqueue. SDK retry database worker dimatikan. Deadline ini mencakup antrean; worker harus aktif saat pekerjaan dibuat.

R2 maksimum tiga attempt lintas restart. Backoff 500/1.000 ms ditambah jitter deterministik 0–250 ms; hormati Retry-After. Hanya 429, 5xx, network error dan timeout provider yang dijadwalkan ulang. Schema/401/403 diterminasi. Worker tidak memegang transaksi DB selama jaringan provider dipanggil.

Finish mengikat run dan lease. Hasil, market_events, status provider dan outbox terminal committed dalam transaksi yang sama. Hasil terminal identik dapat dibaca ulang dengan lease yang sama tanpa posting kedua. Jika respons commit hilang, worker tidak langsung melakukan fetch lagi; claim berikutnya melihat state durable. Jika worker crash sebelum commit, lease kadaluwarsa mengizinkan attempt baru dengan budget lama dan token baru. Worker lama ditolak.

Tidak ada claim memalsukan `event_time`, `sequence` atau `source_event_id`; data search tetap `needs_data`, coverage `PARTIAL`, dan `tradingEligible: false`. `last_success` hanya berarti fetch+schema berhasil disimpan; tidak berarti kualitas data sudah layak trading. Header/body provider dibatasi satu deadline, body maksimal 2 MB, redirect ditolak.

Quota limit/remaining pada provider_states adalah snapshot ketika admission dilakukan, bukan janji izin untuk request berikutnya. Web dan worker memperbaruinya melalui trigger pada ledger bersama; keputusan admission berikutnya tetap menghitung rolling window secara atomik.

## Kontrak observasi E03

Kontrak internal bernama `discovery-observation-v1`; adapter `dexscreener-search-v1`. Ini bukan sertifikasi bahwa semua kontrak B01 2.0 sudah dipenuhi.

- `market_events.id` = observation_id internal, dihasilkan database.
- `source_event_id` = ID asli provider jika tersedia; search menyimpan null.
- `crawl_run_id + instrument_ref` unik untuk satu hasil run. Poll baru boleh menghasilkan observasi baru atas payload sama.
- `received_at` = waktu respons diobservasi; bukan waktu event pasar.
- `payload_hash` mengikat payload yang disimpan. Universe revision dan query asli mengikat input akuisisi.
- `next_cursor` selalu null untuk search. Lifecycle succeeded/failed berbeda dari coverage dan quality.

PRD B01 2.0 yang mensyaratkan source_event_id non-null tidak boleh dinyatakan telah diimplementasikan penuh oleh adapter ini. Perubahan kontrak lintas bot memerlukan versi major dan consumer migration; sebelum itu jalur ini hanya memasok objek discovery untuk pemeriksaan ulang. Consumer E04 harus membaca market_events berdasarkan run, mendeduplikasi event_id outbox dan memeriksa revisi/freshness kembali.

## Pemeriksaan

- `npm test`: identitas, quality/SCAN dasar, schema, transport, batas waktu dan retry.
- `npm run test:integration`: Auth nyata lokal, RLS, RPC, atomic finish, idempotensi dan claim bersamaan. Memerlukan E03_TEST_SUPABASE_URL, E03_TEST_PUBLIC_KEY, E03_TEST_SERVICE_KEY; menolak target nonlokal.
- `supabase/tests/market_crawler.sql`: tes transaksi dengan rollback untuk retry ketiga, crash/lease, quota bersama, backoff, universe revision, outbox dan RLS. Jalankan hanya ketika tidak ada run aktif; script menolak kondisi sebaliknya.
- `supabase db lint --local`, pemeriksaan TypeScript, lint dan build.

Tes fixture tidak membuktikan provider nyata menyediakan sequence, timestamp pasar atau pagination. Pengujian hosted dan pengoperasian worker hosted dicatat terpisah dari pengujian lokal.
