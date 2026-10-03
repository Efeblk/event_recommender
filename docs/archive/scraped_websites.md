# 🌐 Scraped Websites

## 1. Biletix (Disabled)
**Status**: ⛔️ Temporary Disabled (Poor Context Quality)
**URL**: [biletix.com](https://www.biletix.com/search/ISTANBUL/tr)

### Scraped Data Fields (Legacy)
- **Event Title**: Name of the event.
- **Venue**: Location name.
- **Date/Time**: Full date and time string.
- **Category**: Derived from the page or event type.
- **Description**: Detailed event info (if available).
- **Image**: Event poster/banner URL.

---

## 2. Biletinial
**URL**: [biletinial.com](https://biletinial.com)

### Target Categories (Istanbul)
The spider specifically targets these category pages to find events in Istanbul:
- **Music**: [muzik/istanbul](https://biletinial.com/tr-tr/muzik/istanbul)
- **Theater**: [tiyatro/istanbul](https://biletinial.com/tr-tr/tiyatro/istanbul)
- **Cinema**: [sinema/istanbul](https://biletinial.com/tr-tr/sinema/istanbul)
- **Opera & Ballet**: [opera-bale/istanbul](https://biletinial.com/tr-tr/opera-bale/istanbul)
- **Shows**: [gosteri/istanbul](https://biletinial.com/tr-tr/gosteri/istanbul)
- **Workshops**: [egitim/istanbul](https://biletinial.com/tr-tr/egitim/istanbul)
- **Seminars**: [seminer/istanbul](https://biletinial.com/tr-tr/seminer/istanbul)
- **General Events**: [etkinlik/istanbul](https://biletinial.com/tr-tr/etkinlik/istanbul)
- **Entertainment**: [eglence/istanbul](https://biletinial.com/tr-tr/eglence/istanbul)
- **Stand-up**: [etkinlikleri/stand-up](https://biletinial.com/tr-tr/etkinlikleri/stand-up)
- **Symphony**: [etkinlikleri/senfoni-etkinlikleri](https://biletinial.com/tr-tr/etkinlikleri/senfoni-etkinlikleri)

### Scraped Data Fields
- **Price**: Extracted from detail pages (handles "Sold Out" and ranges).
- **Date**: Parsed from listing or extracted from "Vizyon Tarihi" on detail pages.
- **Reviews**: Top user reviews (used for AI sentiment analysis).
- **Ratings**: Star ratings and count.
- **Venue & City**: Location details (defaults to Istanbul for these URLs).

