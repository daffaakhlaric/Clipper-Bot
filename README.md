# 🎬 ClipForge AI — YouTube Clipping Studio

AI-powered tool untuk generate viral clips dari video YouTube secara otomatis.

## Features
- 🔗 Input 1 link YouTube → generate 6 clip ideas otomatis
- 🤖 Claude AI analisis transcript untuk temukan momen terbaik
- ✂️ FFmpeg auto-cut clips berdasarkan timestamp AI
- ⬇️ Download semua clip langsung dari browser
- 📊 Viral Score per clip
- 🎯 5 Strategi: Viral, Educational, Testimonial, Property, Highlights

## Requirements

Install dulu:
```bash
# macOS
brew install yt-dlp ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
pip install yt-dlp

# Windows (pakai chocolatey)
choco install yt-dlp ffmpeg
```

## Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. Set API key
export ANTHROPIC_API_KEY=your_key_here

# 3. Jalankan server
node server.js

# 4. Buka browser
open http://localhost:3030
```

## Cara Pakai

1. **Paste URL YouTube** di input field
2. **Pilih Strategi** (Viral, Educational, Property, dll)
3. **Klik Analyze** → Claude akan analisis video (15–30 detik)
4. **Pilih clip** yang ingin di-generate (atau "Pilih Semua")
5. **Klik Generate Clips** → tunggu proses download + cut
6. **Download** semua clip selesai!

## Strategi Clipping

| Strategi | Tujuan | Platform Terbaik |
|----------|--------|-----------------|
| 🔥 Viral | Hook kuat, momen emosional | TikTok, Reels |
| 📚 Educational | Tips & how-to standalone | YouTube Shorts |
| 💬 Testimonial | Kisah sukses, hasil nyata | Reels, LinkedIn |
| 🏠 Property | Fitur, harga, lokasi | PropertyKlik, Meta Ads |
| ⭐ Highlights | Momen terbaik/memorable | Semua platform |

## Ide Pengembangan Lanjutan

- [ ] Auto burn-in subtitles (ffmpeg + SRT)
- [ ] Crop ke 9:16 untuk Reels/TikTok
- [ ] Batch processing multiple URLs
- [ ] Auto-post ke Meta/TikTok via API
- [ ] PropertyKlik integration untuk listing video
- [ ] Thumbnail auto-generate per clip
- [ ] Webhook notifications setelah selesai

## Tech Stack

- **Backend**: Node.js + Express
- **AI**: Claude claude-sonnet-4-20250514 via Anthropic API
- **Video**: yt-dlp (download) + FFmpeg (cut)
- **Frontend**: Vanilla HTML/CSS/JS
