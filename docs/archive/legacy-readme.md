# EventGraph 🎭

**Istanbul Event Discovery Engine** — A full-stack data pipeline that scrapes, cleans, analyzes, and visualizes event data from real-world Turkish websites.

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![FalkorDB](https://img.shields.io/badge/FalkorDB-Graph_DB-E10098?style=flat-square)
![Scrapy](https://img.shields.io/badge/Scrapy-Playwright-60A839?style=flat-square)

---

## Overview

This project demonstrates a complete data engineering workflow:

1. **Web Scraping** — Extract event data from dynamic JavaScript-rendered pages using Scrapy + Playwright
2. **Data Cleaning** — Handle messy real-world data: Turkish dates, HTML entities, price formats, duplicates
3. **Statistical Analysis** — Apply scipy-based analysis: quartiles, normality tests, anomaly detection
4. **Visualization** — Present insights through an interactive React dashboard with real-time updates

---

## Prerequisites

Before running the project, ensure you have:

| Requirement | Version | Installation |
|-------------|---------|--------------|
| **Python** | 3.11+ | [python.org](https://python.org) |
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org) |
| **Docker** | Latest | [docker.com](https://docker.com) |
| **Ollama** (optional) | Latest | [ollama.ai](https://ollama.ai) |

> **Note**: Ollama is only needed for AI enrichment (`make ai-enrich`). The dashboard works without it.

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Efeblk/2509011061_P2P3.git
cd 2509011061_P2P3

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate   # Windows

# 3. Copy environment file
cp .env.example .env

# 4. Install dependencies and start database
make setup

# 5. Scrape events (takes ~5-10 minutes)
make scrape

# 6. Launch dashboard
make web
# → Dashboard: http://localhost:5173
# → API: http://localhost:8000
```

### Optional: AI Enrichment
```bash
# Install Ollama models first
ollama pull llama3.2
ollama pull mxbai-embed-large

# Run enrichment
make ai-enrich
```

---

## Features

### 🌐 Web Scraping Pipeline
- **Source**: [Biletinial](https://www.biletinial.com) — Turkey's event ticketing platform
- **Technology**: Scrapy framework with Playwright for JavaScript rendering
- **Output**: ~11,000+ events with title, date, venue, price, category, and description

### 🧹 Data Cleaning
Real-world web data is messy. This project handles:

| Challenge | Solution |
|-----------|----------|
| Turkish dates (`"20 Ocak 2025"`) | Custom parser → ISO 8601 format |
| HTML entities (`&nbsp;`, `&#39;`) | `html.unescape()` + whitespace normalization |
| Price formats (`"1.500,00 TL"`) | Regex extraction → float conversion |
| Duplicates | Fingerprint-based deduplication |
| Missing fields | Graceful handling with defaults |

### 📊 Statistical Analysis
Powered by **scipy**, **numpy**, and **pandas**:

- **Descriptive Statistics**: Mean, median, standard deviation, range
- **Distribution Analysis**: Skewness, kurtosis, quartiles (Q1, Q2, Q3), IQR
- **Normality Testing**: Kolmogorov-Smirnov test
- **Anomaly Detection**: IQR method + Z-score method for outlier identification
- **Time Series**: Weekly event trends, day-of-week patterns
- **Segmentation**: Price clustering (Budget/Mid-Range/Premium/Luxury)

### 📈 React Dashboard
Modern, responsive visualization built with:

- **React 18** + **Vite** for fast development
- **Recharts** for data visualization (area charts, bar charts, pie charts)
- **Framer Motion** for smooth animations
- **Tailwind CSS** for styling
- **Real-time updates** via FastAPI backend

**Dashboard Features**:
- Category-wise price analysis with bar charts
- Event distribution pie chart
- Data quality gauge
- Live statistical report (μ, σ, skewness, kurtosis)
- Anomaly detection summary
- Time series trends
- Live scraping progress monitor

---

## Project Structure

```
├── frontend/                 # React dashboard
│   └── src/
│       ├── App.jsx          # Main dashboard
│       └── ProgressPage.jsx # Live progress
├── src/
│   ├── scrapers/            # Scrapy spiders
│   │   ├── spiders/         # biletinial_spider.py
│   │   └── pipelines.py     # Data cleaning
│   ├── analysis/            # Statistical analysis
│   │   ├── statistics.py    # scipy-based analysis
│   │   └── anomaly_detector.py
│   ├── api/                 # FastAPI backend
│   └── ai/                  # AI enrichment (Ollama)
├── tests/                   # Unit tests
├── Makefile                 # All commands
└── README.md
```

---

## Commands

| Command | Description |
|---------|-------------|
| `make setup` | Install dependencies + start database |
| `make scrape` | Scrape events from Biletinial |
| `make web` | Launch React dashboard |
| `make analyze` | Run statistical analysis (terminal) |
| `make ai-enrich` | Generate AI summaries with Ollama |
| `make test` | Run unit tests |
| `make fclean` | Full reset |

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Scraping** | Scrapy + Playwright |
| **Database** | FalkorDB (Redis-based graph database) |
| **Backend** | FastAPI + Uvicorn |
| **Frontend** | React 18 + Vite + Recharts + Framer Motion |
| **Analysis** | scipy, numpy, pandas |
| **AI** | Ollama (Llama 3.2, mxbai-embed-large) |

---

## Sample Analysis Output

```
Statistical Analysis Report
═══════════════════════════════════════════════════════════

Sample Size (n)     : 11,002
Mean (μ)            : 700.45 TL
Median (M)          : 549.00 TL
Std Deviation (σ)   : 652.31 TL
Skewness (γ₁)       : 19.11 (right-skewed)
Kurtosis (γ₂)       : 563.04 (leptokurtic)

Quartile Analysis
─────────────────
Q1 (25th percentile): 300.00 TL
Q2 (50th percentile): 549.00 TL
Q3 (75th percentile): 1,000.00 TL
IQR                 : 700.00 TL

Normality Test (Kolmogorov-Smirnov)
───────────────────────────────────
Result: Non-normal distribution (p < 0.001)

Anomaly Detection
─────────────────
Total Anomalies: 847 (7.7%)
Method: IQR + Z-score
```

---

**Student ID**: 2509011061
**Course**: Web Data Mining (P2 + P3)
**Term**: Fall 2024
