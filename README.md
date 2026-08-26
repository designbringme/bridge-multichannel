# Donation Bridge Multi-Channel (ISOLATED)

Folder ini adalah sistem baru. **Tidak mengubah dan tidak membaca Redis key sistem lama** di `donation-bridge-main/donation-bridge-main`.

## Tujuan

Menghubungkan banyak akun Saweria, SociaBuzz, BagiBagi, Tako, dan provider lain ke banyak game Roblox dengan routing yang jelas:

```text
akun Saweria A ─┐
akun BagiBagi A ─┴─ accountId: areamafia-saweria/bagibagi ─ channel: areamafia ─> Game AreaMafia
akun Saweria B ─── accountId: br-saweria                  ─ channel: br        ─> Game BattleRoyale
```

- `accountId` = identitas satu akun donasi + satu webhook.
- `channel` = kotak/antrian tujuan Roblox. Beberapa akun provider boleh masuk channel yang sama **jika memang ingin satu game menerima semuanya**.
- Game Roblox hanya membaca satu `accountId` dan memakai `pollSecret` miliknya.
- Game lain memakai account/channel/secret berbeda, sehingga tidak tercampur.

> Catatan penting: route webhook menggunakan `accountId`, karena provider biasanya tidak mengirim identitas akun yang cukup konsisten. Jadi jangan berharap bridge dapat menebak akun hanya dari `platform`.

## File baru

```text
donation-bridge-multichannel/
├── api/index.js                 # API baru, terisolasi
├── roblox/MultiDonationConfig.luau
├── roblox/MultiDonationPoller.luau
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

File asli tetap berada di folder lamanya dan tidak perlu diganti.

## 1. Buat Redis baru / gunakan Redis yang sama

Buat Upstash Redis baru (disarankan), atau database lama boleh dipakai karena key sistem baru diberi prefix:

```text
donation-multichannel:v1:<channel>
donation-multichannel:v1:dedupe:<channel>:<platform>:<providerId>
```

Sistem baru tidak memakai key `donations` milik bridge lama.

## 2. Siapkan daftar akun dan secret

Salin `.env.example` menjadi environment variable Vercel. Isi `DONATION_CHANNELS_JSON` satu entry per akun donasi:

```json
{
  "areamafia-saweria": {
    "channel": "areamafia",
    "webhookSecret": "S3cret-webhook-areamafia-saweria-2026",
    "pollSecret": "S3cret-poll-areamafia-saweria-2026"
  },
  "areamafia-bagibagi": {
    "channel": "areamafia",
    "webhookSecret": "S3cret-webhook-areamafia-bagibagi-2026",
    "pollSecret": "S3cret-poll-areamafia-bagibagi-2026"
  },
  "battle-saweria": {
    "channel": "battle",
    "webhookSecret": "S3cret-webhook-battle-saweria-2026",
    "pollSecret": "S3cret-poll-battle-saweria-2026"
  }
}
```

Gunakan random string minimal 16 karakter dan jangan commit `.env` atau secret ke GitHub. Untuk banyak akun, tambah entry baru; jangan memakai secret yang sama.

### Contoh pemetaan

| Akun provider | URL webhook | Tujuan |
|---|---|---|
| Saweria AreaMafia | `/api/webhook/saweria/areamafia-saweria?key=...` | channel `areamafia` |
| BagiBagi AreaMafia | `/api/webhook/bagibagi/areamafia-bagibagi?key=...` | channel `areamafia` |
| Saweria Battle | `/api/webhook/saweria/battle-saweria?key=...` | channel `battle` |

`accountId` hanya boleh berisi huruf, angka, `_`, `-`.

## 3. Deploy folder baru ke Vercel

Buat repository baru berisi **isi folder `donation-bridge-multichannel`**, lalu import repository tersebut di Vercel. Atau deploy dari folder ini menggunakan Vercel CLI.

Environment Variables yang wajib:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `DONATION_CHANNELS_JSON`

Opsional untuk test manual:

- `TEST_SECRET` — jika tidak diisi, endpoint test selalu mati.

Set environment untuk Production (dan Preview bila diperlukan), lalu redeploy setelah mengubah variable.

Health check:

```text
GET https://NAMA-PROJECT.vercel.app/
```

Harus menghasilkan `Donation Bridge Multi-channel running`.

## 4. Pasang webhook di setiap akun provider

Untuk setiap akun, masukkan URL yang sesuai pada dashboard provider:

```text
Saweria:
https://NAMA-PROJECT.vercel.app/api/webhook/saweria/areamafia-saweria?key=S3cret-webhook-areamafia-saweria-2026

BagiBagi:
https://NAMA-PROJECT.vercel.app/api/webhook/bagibagi/areamafia-bagibagi?key=S3cret-webhook-areamafia-bagibagi-2026

SociaBuzz:
https://NAMA-PROJECT.vercel.app/api/webhook/sociabuzz/battle-sociabuzz?key=...

Tako:
https://NAMA-PROJECT.vercel.app/api/webhook/tako/music-tako?key=...
```

Nama menu webhook berbeda-beda tiap provider. Pastikan provider mengirim JSON atau form-urlencoded. `api/index.js` menormalisasi field umum, tetapi payload nyata tiap provider sebaiknya dites.

### Keamanan webhook

- `key` wajib benar; request tanpa key mendapat `401`.
- Jangan gunakan URL webhook di chat publik jika berisi key.
- Jika key bocor, ganti `webhookSecret` di Vercel dan pasang URL baru di provider.
- Dukungan signature resmi provider belum bisa diasumsikan sama untuk semua provider. Jika dashboard provider menyediakan HMAC/signature, tambahkan validasi provider-specific sebelum produksi.

## 5. Pasang Roblox untuk setiap game

Di setiap experience/game tujuan:

1. Aktifkan **Game Settings → Security → Allow HTTP Requests**.
2. Buat `ReplicatedStorage > Shared` jika belum ada.
3. Copy `roblox/MultiDonationConfig.luau` menjadi ModuleScript bernama `MultiDonationConfig` di `ReplicatedStorage.Shared`.
4. Isi URL, `channel`, dan `pollSecret` sesuai account entry yang dipilih.
5. Copy `roblox/MultiDonationPoller.luau` menjadi Script bernama `MultiDonationPoller` di `ServerScriptService`.
6. Pastikan feature efek/leaderboard cash yang sudah ada mendengarkan `MultiDonationRemotes.RealDonationForBoard`, atau adaptasikan bridge event-nya. Poller baru sengaja memakai folder `MultiDonationRemotes` agar tidak mengganggu remotes lama.
7. Publish dan uji di server live.

Contoh config AreaMafia:

```lua
MultiDonationConfig.bridgeUrl   = "https://NAMA-PROJECT.vercel.app"
MultiDonationConfig.channel     = "areamafia"
MultiDonationConfig.pollSecret  = "S3cret-poll-areamafia-saweria-2026"
```

Contoh config Battle memakai entry `battle-saweria`:

```lua
MultiDonationConfig.channel    = "battle"
MultiDonationConfig.pollSecret = "S3cret-poll-battle-saweria-2026"
```

Untuk memasukkan **dua akun provider ke satu game**, masing-masing akun memiliki webhook/accountId sendiri tetapi menggunakan `channel` sama. Game harus memakai `pollSecret` dari account yang dipilih; jika ingin polling gabungan multi-account, buat satu `pollSecret` khusus channel dan ubah registry/API menjadi channel-level poll credential. Versi awal ini sengaja membatasi satu account polling agar akses game dapat dicabut per akun.

## 6. Endpoint

| Method | Endpoint | Auth |
|---|---|---|
| `GET` | `/` | tidak ada, health only |
| `POST` | `/api/webhook/:platform/:accountId?key=...` | webhook secret akun |
| `GET` | `/api/tail/:accountId?pollKey=...` | poll secret akun |
| `GET` | `/api/donations/:accountId?pollKey=...&after=...` | poll secret akun |
| `GET` | `/api/test/:accountId?testKey=...` | disabled kecuali `TEST_SECRET` |

Poller mengirim parameter `key` sebagai kompatibilitas dengan script saat ini; API juga menerima `pollKey` untuk endpoint polling. Saat memasang script, gunakan versi yang konsisten dengan route yang dipakai.

## 7. Deduplikasi dan cursor

Webhook provider sering mengirim ulang event. Bridge menyimpan dedupe marker berdasarkan:

```text
channel + platform + provider transaction ID
```

Jika provider tidak mengirim transaction ID, bridge memakai hash payload. Event kedua dijawab sukses sebagai `duplicate` dan tidak masuk antrian dua kali.

Roblox melakukan bootstrap cursor dari `/api/tail`, sehingga donasi lama tidak diputar ulang saat server baru hidup. Donasi baru diambil dengan `after` cursor.

## 8. Troubleshooting

- `401 Unauthorized` webhook: `accountId` atau `key` tidak match, atau secret < 16 karakter.
- `404 Unknown route`: accountId belum ada di `DONATION_CHANNELS_JSON`, atau platform salah eja.
- Roblox `401`: config poller memakai secret yang bukan `pollSecret` untuk accountId tersebut.
- Tidak ada event: cek HTTP Requests, URL, payload provider, nominal > 0, dan deployment environment Production.
- Event masuk game salah: periksa tiga hal di tabel registry: webhook URL → accountId → channel; jangan hanya melihat nama platform.
- Donasi lama tidak muncul: ini normal setelah bootstrap tail; kirim test donasi baru.

## Perbedaan dengan bridge lama

Bridge lama tetap dapat dipakai oleh game lama. Bridge baru memiliki URL/deployment sendiri dan endpoint baru. Jangan mengubah webhook lama ke endpoint baru sebelum konfigurasi baru diuji; perpindahan itu akan menjadi keputusan operasional terpisah.
