# 🎯 LeadGen Pro

**AI-Powered Multi-Platform Lead Extraction System**

Extract fresh leads from Google, Reddit, Facebook, Instagram, Twitter & Upwork with automated email discovery, deduplication, and Excel export.

![LeadGen Pro Dashboard](https://img.shields.io/badge/Status-Active-success) ![License](https://img.shields.io/badge/License-MIT-blue) ![Node](https://img.shields.io/badge/Node-18+-green)

---

## ✨ Features

- **Multi-Platform Scraping** — Extract leads from 6+ platforms simultaneously
- **Fresh Leads** — Filter by timeframe (24h, 7 days, 30 days)
- **Region Targeting** — Focus on US, UK, Canada, Australia, or worldwide
- **Email Extraction** — Automatically detect emails in posts/listings
- **Smart Deduplication** — Never get duplicate leads across sessions
- **Excel Export** — One-click download of all leads
- **Professional Dashboard** — Beautiful, responsive web interface
- **API Ready** — RESTful API for automation and integrations

---

## 📱 Supported Platforms

| Platform | Type | Method |
|----------|------|--------|
| 🔍 Google | Search | Direct API |
| 🤖 Reddit | Social | Direct API |
| 📘 Facebook | Social | Direct API |
| 📸 Instagram | Social | Direct API |
| 🐦 Twitter | Social | Direct API |
| 💼 Upwork | Jobs | Via Google |

---

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/FahadImdad/Leadgen-pro.git
cd Leadgen-pro
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure API keys

```bash
cp .env.example .env
```

Edit `.env` and add your Apify API token:

```
APIFY_API_TOKEN=your_apify_token_here
```

### 4. Start the server

```bash
npm start
```

### 5. Open dashboard

Navigate to `http://localhost:3000` in your browser.

---

## 🔑 API Keys Setup

### Apify (Required)

1. Sign up at [apify.com](https://apify.com) (free $5 credits)
2. Go to Settings → Integrations → API Token
3. Copy and add to `.env` file

### Optional Services

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| Hunter.io | Email verification | 50/month |
| Supabase | Cloud database | Generous |

---

## 📊 Dashboard Features

### Extraction Settings
- **Keywords** — Enter multiple keywords (one per line)
- **Platforms** — Select which platforms to search
- **Region** — Target specific countries
- **Timeframe** — Filter by recency
- **Max Results** — Control volume per platform

### Results View
- Sortable table with all leads
- Source badges for easy identification
- Direct links to original posts
- Copy all emails with one click
- Export to Excel

---

## 🛠️ API Endpoints

### Check Status
```http
GET /api/status
```

### Run Extraction
```http
POST /api/extract
Content-Type: application/json

{
  "keywords": ["book publishing", "web development"],
  "platforms": ["google", "reddit", "facebook"],
  "region": "us",
  "timeframe": "d",
  "maxResults": 20
}
```

### Export to Excel
```http
GET /api/export
```

---

## 💰 Pricing Estimate

### Free Tier (Demo)
- Apify: $5 free credits
- ~100-200 leads extraction

### Production (15K leads/month)

| Service | Plan | Monthly Cost |
|---------|------|--------------|
| Apify | Starter | $29 |
| Total | | **$29-100** |

---

## 📁 Project Structure

```
leadgen-pro/
├── server.js           # Express server & API
├── index.js            # CLI entry point
├── package.json        # Dependencies
├── .env.example        # Environment template
├── public/
│   └── index.html      # Dashboard UI
├── src/
│   └── LeadExtractor.js # Core extraction logic
├── config/
│   └── keywords.json   # Default keywords
├── data/               # Deduplication database
└── output/             # Excel exports
```

---

## 🔧 Tech Stack

- **Backend** — Node.js, Express
- **Frontend** — Vanilla JS, CSS3
- **Scraping** — Apify Client
- **Export** — XLSX
- **Database** — JSON (local) / Supabase (cloud)

---

## 📝 License

MIT License - feel free to use for personal or commercial projects.

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a PR.

---

## 📧 Contact

Built by [Fahad Imdad](https://github.com/FahadImdad)

---

**⭐ Star this repo if you find it useful!**
