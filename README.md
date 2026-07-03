# Indoxxi21 Mirror — Cloudflare Worker

Reverse-proxy mirror yang **powerful** untuk situs sumber, dengan fokus pada:

- ✅ **Anti-duplikat SEO** — hilangkan error Google Search Console:
  _"Duplikat, Google memilih versi kanonis berbeda"_, _"Halaman dengan pengalihan"_,
  _"Data terstruktur Breadcrumb"_, _"Data terstruktur tidak dapat diurai"_.
- ✅ **Full mirror** — HTML, CSS, JS, gambar, **AJAX video player**, sitemap, robots.txt.
- ✅ **Blokir iklan judi/slot & popup** — tanpa merusak video player di postingan.
- ✅ **Tema Glassmorphism** modern yang di-inject otomatis.

> **Tanpa Wrangler / tanpa npm.** Cukup salin isi [worker.js](worker.js) dan tempel
> langsung ke editor Cloudflare Workers di dashboard.

## Konfigurasi

Semua pengaturan ada di objek `CONFIG` paling atas [worker.js](worker.js#L28):

```js
const CONFIG = {
  ORIGIN: "comblank.com",     // domain sumber yang di-mirror
  MIRROR: "indoxxi21.net",    // domain mirror Anda
  SITE_NAME: "INDOXXI - IDLIX",
  LOCALE: "id_ID",
  ...
};
```

- **`ALLOW_HOSTS`** — host video/streaming yang WAJIB dibiarkan (mis. `abyssplayer.com`).
- **`BLOCK_HOSTS`** — domain iklan/tracker yang diblokir (`klik.gg`, `klik.top`, dll).
- **`ALSO_REWRITE`** — domain lain milik jaringan sumber yang ikut di-rewrite ke mirror.

## Cara SEO diperbaiki

| Masalah GSC | Perbaikan otomatis |
|-------------|--------------------|
| Google pilih kanonis berbeda | `rel="canonical"` dipaksa **self-referencing** per-URL ke domain mirror. |
| Duplikat | Semua `og:url`, share link, JSON-LD `@id`/`url` di-rewrite ke mirror. |
| Data terstruktur Breadcrumb | `"position":"1"` (string) → `1` (integer). |
| Data terstruktur tak dapat diurai | JSON-LD di-`parse` ulang & di-serialize valid; `width`/`height`/rating string → number. |
| Halaman dengan pengalihan | Redirect origin (3xx) di-rewrite ke path mirror agar tetap internal. |
| Tidak ditemukan (404) | Referensi stylesheet sitemap (`.xsl`) & aset diperbaiki agar tidak 404. |
| Locale salah | `og:locale` → `id_ID`, `<html lang>` → `id-ID`. |

Sitemap tetap tersedia di `https://<mirror>/sitemap_index.xml` dan seluruh `<loc>`
di-rewrite otomatis ke domain mirror. `robots.txt` dilayani sendiri oleh Worker
dan menunjuk ke sitemap mirror.

## Video player

Player memuat iframe (mis. `abyssplayer.com`) via `POST /wp-admin/admin-ajax.php`
(`action=muvipro_player_content`). Worker **mem-proxy** endpoint ini apa adanya,
dan **tidak pernah** menghapus script `muvipro`/`idmuvi`/player saat blokir iklan.
Iklan hanya dihapus jika bukan bagian dari player.

## Cara deploy (dashboard Cloudflare, tanpa Wrangler)

1. Masuk ke **Cloudflare Dashboard** → **Workers & Pages** → **Create** → **Create Worker**.
2. Beri nama (mis. `indoxxi21-mirror`) lalu **Deploy**.
3. Klik **Edit code**, hapus kode contoh, lalu **salin seluruh isi [worker.js](worker.js)** dan tempel.
4. Klik **Deploy**.
5. Buka **Settings → Domains & Routes** (atau **Triggers → Routes**):
   - Tambahkan **Custom Domain** `indoxxi21.net` **atau** Route `indoxxi21.net/*`.
   - (Opsional) tambahkan juga `www.indoxxi21.net/*`.

Selesai. Tidak perlu install apa pun di komputer Anda.

## Catatan penting

- **Ganti `MIRROR`** di `CONFIG` bila domain Anda berbeda, lalu re-deploy.
- Setelah deploy, submit `https://<mirror>/sitemap_index.xml` ke Google Search Console.
- Toggle fitur tersedia di `CONFIG`: `ENABLE_THEME`, `ENABLE_ADBLOCK`, `ENABLE_SEO_FIX`, `DEBUG`.
- Jika muncul iklan dari domain baru, cukup tambahkan domainnya ke `BLOCK_HOSTS`.