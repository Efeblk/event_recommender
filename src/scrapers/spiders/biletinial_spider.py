"""
Biletinial spider for scraping events from biletinial.com
"""

import asyncio
import uuid
import scrapy

# print("MODULE LOAD: BILETINIAL SPIDER V2 LOADED!!!!!!!!!!!!!")
# import asynciorapy
import re
import asyncio
from datetime import datetime
from src.scrapers.spiders.base import BaseEventSpider
from src.scrapers.items import EventItem
from src.utils.date_parser import parse_turkish_date_range, extract_date_from_title


class BiletinialSpider(BaseEventSpider):
    """
    Spider for scraping events from Biletinial.
    Extracts ratings directly from listing pages for efficiency.
    Visits detail pages to extract reviews and dates when needed.
    """

    name = "biletinial"
    allowed_domains = ["biletinial.com"]

    def __init__(self, limit=None, *args, **kwargs):
        super(BiletinialSpider, self).__init__(*args, **kwargs)
        self.playwright_page = None
        self.limit = int(limit) if limit else None

        # All categories from docs/archive/scraped_websites.md - REMOVED /istanbul suffix
        self.start_urls = [
            "https://biletinial.com/tr-tr/muzik",
            "https://biletinial.com/tr-tr/tiyatro",
            "https://biletinial.com/tr-tr/sinema",
            "https://biletinial.com/tr-tr/opera-bale",
            "https://biletinial.com/tr-tr/gosteri",
            "https://biletinial.com/tr-tr/egitim",
            "https://biletinial.com/tr-tr/seminer",
            "https://biletinial.com/tr-tr/etkinlik",
            "https://biletinial.com/tr-tr/eglence",
            "https://biletinial.com/tr-tr/etkinlikleri/stand-up",
            "https://biletinial.com/tr-tr/etkinlikleri/senfoni-etkinlikleri",
            "https://biletinial.com/tr-tr/spor",
        ]

        # Allow overriding start_urls for testing specific pages
        if kwargs.get("start_url"):
            self.start_urls = [kwargs.get("start_url")]
            self.logger.info(f"🐞 DEBUG MODE: Overriding start_urls to {self.start_urls}")

    custom_settings = {
        **BaseEventSpider.custom_settings,
        "PLAYWRIGHT_PROCESS_REQUEST_HEADERS": None,
        # Note: CONCURRENT_REQUESTS and DOWNLOAD_DELAY are now controlled via .env
        # See .env: SCRAPY_CONCURRENT_REQUESTS and SCRAPY_DOWNLOAD_DELAY
        "RETRY_TIMES": 2,
    }

    def start_requests(self):
        """Generate initial requests with Playwright."""
        for url in self.start_urls:
            yield scrapy.Request(
                url=url,
                callback=self.parse,
                meta={
                    "playwright": True,
                    "playwright_include_page": True,
                    "playwright_page_init_callback": self.init_page,
                    "playwright_page_goto_kwargs": {
                        "wait_until": "domcontentloaded",
                        "timeout": 60000,
                    },
                },
                errback=self.errback_close_page,
            )

    async def init_page(self, page, request):
        """Initialize page with resource blocking."""
        await page.route("**/*", self.route_handler)

    async def route_handler(self, route):
        """Block unnecessary resources to speed up scraping."""
        if route.request.resource_type in ["image", "media", "font", "stylesheet"]:
            await route.abort()
        else:
            await route.continue_()

    async def parse(self, response):
        """Parse the main events listing page."""
        page = response.meta["playwright_page"]

        # USE wait_for_selector to ensure we don't miss it due to loading lag
        detail_container = None
        try:
            # Wait up to 5s for any detail indicator
            detail_container = await page.wait_for_selector(
                ".movie-detail-content, .yds_cinema_movie_thread, .yds_cinema_movie_thread_info, .event-detail-content",
                timeout=5000,
            )
        except Exception:
            pass

        if detail_container:
            self.logger.info("🐞 DEBUG MODE: Direct detail page detected, parsing single event...")
            async for item in self.parse_event_detail(response):
                yield item
            return

        # Check if we need to select a city (for category pages like concerts)
        # DISABLE ISTANBUL SELECTION FOR TURKEY-WIDE SCRAPING
        # Look for city selector dropdown
        # try:
        #     # Try the concerts page city selector first
        #     city_selector = page.locator("select#citySelect, select.customSelect").first
        #     is_selector_visible = await city_selector.is_visible(timeout=3000)
        #
        #     if is_selector_visible:
        #         self.logger.info("🔍 Found city selector, selecting İstanbul...")
        #
        #         # Select Istanbul from dropdown (value="147" for İstanbul Tümü)
        #         await city_selector.select_option(value="147")
        #         self.logger.info("✓ Selected İstanbul from city selector")
        #
        #         # Wait for the filter to apply (JavaScript onchange event)
        #         await asyncio.sleep(5)
        #     else:
        #         # Try the modal-based city selector (yhm_select_city)
        #         modal_selector = page.locator("select.yhm_select_city, select[name='city']").first
        #         is_modal_visible = await modal_selector.is_visible(timeout=2000)
        #
        #         if is_modal_visible:
        #             self.logger.info("🔍 Found modal city selector, selecting İstanbul...")
        #             await modal_selector.select_option(value="istanbul")
        #
        #             save_button = page.locator("button.yhm_save").first
        #             if await save_button.is_visible(timeout=2000):
        #                 await save_button.click()
        #                 self.logger.info("✓ Clicked save button")
        #                 await asyncio.sleep(5)
        # except Exception as e:
        #     self.logger.info(f"No city selector found (page may already be city-specific): {e}")

        # Wait for event list to load (different selectors for different page types)
        # LOGGING: Track which selector matched for debugging layout changes
        event_list_selector = None
        try:
            # Try city-specific page layout first
            await page.wait_for_selector("ul.sehir-detay__liste", timeout=5000)
            event_list_selector = "ul.sehir-detay__liste li"
            self.logger.info("✓ Selector matched: 'ul.sehir-detay__liste' (city-specific layout)")
        except Exception:
            try:
                # Try category page layout (music, theater) - kategori__etkinlikler
                await page.wait_for_selector("#kategori__etkinlikler ul", timeout=5000)
                event_list_selector = "#kategori__etkinlikler ul li"
                self.logger.info("✓ Selector matched: '#kategori__etkinlikler' (category layout)")
            except Exception:
                try:
                    # Try category page layout with resultsGrid (concerts, etc.)
                    await page.wait_for_selector(".resultsGrid", timeout=5000)
                    event_list_selector = ".resultsGrid > a"
                    self.logger.info("✓ Selector matched: '.resultsGrid' (grid layout)")
                except Exception:
                    self.logger.warning("⚠️ None of the expected selectors matched")
                    pass

        if not event_list_selector:
            self.logger.warning("❌ No event list selector found - page layout may have changed")
            await page.close()
            return

        # OPTIMIZATION: Wait for dynamic content with network idle instead of fixed delay
        try:
            await page.wait_for_load_state('networkidle', timeout=5000)
        except:
            # Fallback to short wait if networkidle not reached
            await asyncio.sleep(1)

        # Click "Daha Fazla Yükle" (Load More) button multiple times
        max_clicks = 500
        clicks = 0

        self.logger.info("🔄 Looking for 'Daha Fazla Yükle' button...")

        for i in range(max_clicks):
            try:
                # Count events before clicking (use the detected selector)
                events_before = await page.locator(event_list_selector).count()

                # Optimization: Stop catching if we already have enough events
                if self.limit and events_before >= self.limit:
                    self.logger.info(f"✓ Limit reached ({self.limit} events), stopping 'Load More' clicks.")
                    break

                # Look for the load more button
                load_more_button = page.locator(
                    "a.btn.btn-block.btn-primary.btn-lg.btn-load-more, .daha-fazla-yukle, a:has-text('Daha Fazla')"
                ).first
                if await load_more_button.is_visible(timeout=2000):
                    await load_more_button.click()

                    # OPTIMIZATION: Wait for network idle after click instead of fixed 2s delay
                    try:
                        await page.wait_for_load_state('networkidle', timeout=3000)
                    except:
                        # Fallback to shorter wait
                        await asyncio.sleep(1)

                    clicks += 1
                else:
                    self.logger.info("✓ No 'Load More' button found.")
                    break
            except Exception as e:
                self.logger.info(f"✓ Error during load more loop: {e}")
                break

        if True:  # Changed from if clicks > 0
            self.logger.info(f"✅ Finished pagination loop after {clicks} clicks")

            # Replace response body
            content = await page.content()
            response = response.replace(body=content.encode("utf-8"))

            # Find all event items in the list (use the detected selector)
            events = response.css(event_list_selector)
            total_on_page = len(events)

            self.logger.info(f"📊 Found {total_on_page} event elements on page")

            events_yielded = 0
            events_skipped = 0

            # Parse each event
            for idx, event in enumerate(events, 1):
                # Enforce limit on processing
                if self.limit and events_yielded >= self.limit:
                    self.logger.info(f"🛑 Limit reached: {self.limit} events processed. Stopping.")
                    break

                try:
                    # Extract data
                    title = self.extract_title(event)
                    venue = self.extract_venue(event)
                    city = self.extract_city(event)
                    date_string = self.extract_date(event)
                    url = self.extract_url(event, response)
                    image_url = self.extract_image(event)
                    event_type = self.extract_type(event)
                    rating, rating_count = self.extract_rating(event)

                    if title:  # Only yield if we have at least a title
                        # If no date found, try to extract from title
                        if not date_string or not date_string.strip():
                            date_from_title = extract_date_from_title(title)
                            if date_from_title:
                                self.logger.debug(f"Extracted date from title '{title}': {date_from_title}")
                                date_string = date_from_title

                        # Decide whether to visit detail page
                        # We ALWAYS need to visit detail page for PRICE now
                        needs_date = not date_string or not date_string.strip()
                        has_reviews = rating_count and rating_count > 0

                        if url:
                            self.logger.debug(f"Will visit detail page for '{title}' (Knowledge Graph extraction)")

                            # knowledge-graph: We ALWAYS visit the detail page now to get:
                            # 1. Full Description
                            # 2. Structured Entities (Writer, Director, Cast)
                            # 3. User Reviews

                            # Pass all known data (date, price, etc.) to the detail parser
                            meta = {
                                "title": title,
                                "venue": venue,
                                "city": city,
                                "date_string": date_string,  # might be None
                                "price": None,  # Price not visible on listing page
                                "url": url,
                                "image_url": image_url,
                                "event_type": event_type,
                                "rating": rating,
                                "rating_count": rating_count,
                                "playwright": True,
                                "playwright_include_page": True,
                                "playwright_page_init_callback": self.init_page,
                                "playwright_page_goto_kwargs": {
                                    "wait_until": "domcontentloaded",
                                    "timeout": 60000,
                                },
                            }

                            yield scrapy.Request(
                                url,
                                callback=self.parse_event_detail,
                                meta=meta,
                                dont_filter=True,  # Allow re-visiting if needed
                                errback=self.errback_close_page,
                            )
                            events_yielded += 1
                        else:
                            # Parse date range into individual dates
                            individual_dates = parse_turkish_date_range(date_string)

                            # Yield separate event for each date
                            for individual_date in individual_dates:
                                event_item = EventItem(
                                    title=self.clean_text(title),
                                    venue=self.clean_text(venue) if venue else None,
                                    city=self.clean_text(city) if city else None,
                                    date=individual_date,
                                    price=None,
                                    url=url,
                                    image_url=image_url,
                                    category=event_type if event_type else "Etkinlik",
                                    source="biletinial",
                                    rating=rating,
                                    rating_count=rating_count,
                                    uuid=str(uuid.uuid4()),
                                )

                                self.log_event(event_item)
                                events_yielded += 1
                                yield event_item
                    else:
                        events_skipped += 1

                except Exception as e:
                    self.logger.warning(f"Error parsing event {idx}: {e}")
                    events_skipped += 1
                    continue

            # Verification: Check if we processed all events
            processed_total = events_yielded + events_skipped

            self.logger.info(
                f"✓ Processed {processed_total}/{total_on_page} events: {events_yielded} yielded, {events_skipped} skipped"
            )

            # Alert if there's a mismatch
            if processed_total != total_on_page:
                self.logger.warning(f"⚠️  MISMATCH: Processed {processed_total} but found {total_on_page} on page!")
            elif events_skipped > 0:
                self.logger.info(
                    f"✅ All {total_on_page} events processed ({events_skipped} skipped due to missing data)"
                )
            else:
                self.logger.info(f"✅ All {total_on_page} events successfully processed!")

        await page.close()

    async def parse_event_detail(self, response):
        """
        Parse event detail page to extract event date and PRICE.
        This is called for events that don't have dates on the listing page.
        Handles cinema (Vizyon Tarihi), stand-up, concerts, and other event types.
        """
        self.logger.info("DEBUG: parse_event_detail called")
        page = response.meta["playwright_page"]

        try:
            # Wait for page to load
            await page.wait_for_load_state("domcontentloaded")
            await asyncio.sleep(2)  # Wait for dynamic content

            # Initialize metadata variables
            refined_category = None
            genre = None
            duration = None

            # Check for SOLD OUT first - MOVED TO SCOPED SECTION
            duration = None

            # --- NEW METADATA EXTRACTION (Global Scope) ---
            # 1. Refine Category from top paragraph (e.g., "Seyfi Bey Tiyatro Oyunu")
            try:
                cat_el = await page.query_selector(".yds_cinema_movie_thread_info p")
                if cat_el:
                    cat_text = await cat_el.inner_text()
                    if cat_text:
                        refined_category = self.clean_text(cat_text)
                        self.logger.info(f"✓ Extracted specific category: {refined_category}")
            except Exception as e:
                self.logger.debug(f"Category extraction failed: {e}")

            # 2. Extract Genre (Etkinlik Türü)
            try:
                # Look for strong tag with "Etkinlik Türü" and get following span
                genre_el = await page.query_selector(
                    '.yds_cinema_movie_thread_detail li strong:has-text("Etkinlik Türü") + span'
                )
                if genre_el:
                    genre = await genre_el.inner_text()
                    if genre:
                        genre = self.clean_text(genre)
                        self.logger.info(f"✓ Extracted genre: {genre}")
            except Exception as e:
                self.logger.debug(f"Genre extraction failed: {e}")

            # 3. Extract Duration (Süre)
            try:
                dur_el = await page.query_selector('.yds_cinema_movie_thread_detail li strong:has-text("Süre") + span')
                if dur_el:
                    duration = await dur_el.inner_text()
                    if duration:
                        duration = self.clean_text(duration)
                        self.logger.info(f"✓ Extracted duration: {duration}")
            except Exception as e:
                self.logger.debug(f"Duration extraction failed: {e}")
            # -------------------------------

            is_sold_out = False
            final_price = None

            # SCOPED EXTRACTION: Search only within Istanbul containers first
            # The DOM typically lists events by city for tours:
            # <div data-sehir="İstanbul Avrupa">...</div>
            # We want to find the container for "İstanbul" (Anadolu or Avrupa)
            # User explicitly requested "istanbul anadolu" and "istanbul avrupa"

            # Try to find Istanbul specific containers
            istanbul_container = await page.query_selector('div[data-sehir*="İstanbul"], div[data-sehir*="istanbul"]')

            # Check if this is a tour page (has multiple cities)
            all_city_containers = await page.query_selector_all("div[data-sehir]")
            is_tour_page = len(all_city_containers) > 0

            if istanbul_container:
                self.logger.info("✓ Found Istanbul-specific event section, scoping price extraction.")
                search_scope = istanbul_container
            elif is_tour_page:
                self.logger.warning(
                    "⚠️ Tour page detected but NO Istanbul container found. Skipping price extraction to avoid wrong city."
                )
                search_scope = None  # Explicitly disable search scope to avoid picking up Adana etc.
            else:
                # Single event page, safe to use page scope
                search_scope = page

            self.logger.info(f"DEBUG: search_scope set. is_tour_page={is_tour_page}")

            if search_scope:
                # Check for SOLD OUT within the scope
                try:
                    sold_out_el = await search_scope.query_selector('.tukendi-yeni, button:has-text("TÜKENDİ")')
                    if sold_out_el:
                        self.logger.info(f"⚠️ Event is SOLD OUT in Istanbul: '{response.meta.get('title')}'")
                        is_sold_out = True
                except Exception:
                    pass

            self.logger.info(f"DEBUG: is_sold_out={is_sold_out}")

            self.logger.info("DEBUG: Starting Price Extraction")
            # Try 1: data-ticketprices JSON attribute (Most Reliable)
            # Even if marked sold out, check JSON because it might be a false positive or partial availability
            try:
                # Wait for tooltip to ensure it's loaded
                try:
                    await page.wait_for_selector(".ticket_price_tooltip", timeout=5000)
                    self.logger.info("DEBUG: .ticket_price_tooltip appeared")
                except Exception:
                    self.logger.info("DEBUG: .ticket_price_tooltip wait timed out")

                # Extract raw price data for finding min price
                ticket_tooltip = await search_scope.query_selector(".ticket_price_tooltip")

                # Fallback to global page if scoped search failed and we are scoped
                if not ticket_tooltip and search_scope != page:
                    ticket_tooltip = await page.query_selector(".ticket_price_tooltip")
                    if ticket_tooltip:
                        self.logger.info("DEBUG: Found .ticket_price_tooltip in global scope (fallback)")

                if ticket_tooltip:
                    self.logger.info("DEBUG: Found .ticket_price_tooltip")
                    data_ticketprices = await ticket_tooltip.get_attribute("data-ticketprices")
                    if data_ticketprices:
                        self.logger.info(f"DEBUG: Found data-ticketprices (len={len(data_ticketprices)})")
                        import json
                        import html

                        # Decode HTML entities
                        json_str = html.unescape(data_ticketprices)
                        data = json.loads(json_str)
                        prices = []

                        if "prices" in data and isinstance(data["prices"], list):
                            self.logger.info(f"debug: Found 'prices' list in JSON: {len(data['prices'])} items")
                            extracted_category_prices = []
                            for p_item in data["prices"]:
                                # p_item example: {"name": "1. Kategori", "price": "₺1.200,00", ...}
                                cat_name = p_item.get("name")
                                cat_price_raw = p_item.get("price")

                                if cat_price_raw:
                                    # Clean price: "₺1.200,00" -> 1200.0
                                    cleaned_p = (
                                        str(cat_price_raw)
                                        .replace("₺", "")
                                        .replace("TL", "")
                                        .replace(".", "")
                                        .replace(",", ".")
                                        .strip()
                                    )
                                    try:
                                        import re

                                        match = re.search(r"(\d+(?:\.\d+)?)", cleaned_p)
                                        if match:
                                            price_val = float(match.group(1))
                                            extracted_category_prices.append({"name": cat_name, "price": price_val})
                                            prices.append(price_val)
                                    except ValueError:
                                        pass

                            if extracted_category_prices:
                                self.logger.info(f"✓ Extracted {len(extracted_category_prices)} category prices")
                                # Store in a temporary attribute to pass to item later
                                response.meta["category_prices"] = extracted_category_prices
                        else:
                            self.logger.info("DEBUG: 'prices' list NOT found in JSON")

                        # Extract Venue and City from JSON if available
                        if "venue_name" in data and data["venue_name"]:
                            json_venue_full = data["venue_name"]
                            self.logger.info(f"✓ Found venue info in JSON: '{json_venue_full}'")

                            # Usually format is "Venue Name, City Name" or just "Venue Name"
                            # We update the meta only if we don't have good data yet
                            # But JSON is likely higher quality than listing page scraping, so let's use it
                            parts = [p.strip() for p in json_venue_full.rsplit(",", 1)]

                            json_venue = parts[0]
                            json_city = parts[1] if len(parts) > 1 else None

                            # Heuristic: verify if the second part is actually a city
                            known_cities = [
                                "İstanbul",
                                "Ankara",
                                "İzmir",
                                "Antalya",
                                "Bursa",
                                "Eskişehir",
                                "Muğla",
                                "Adana",
                                "Mersin",
                            ]
                            if json_city and not any(c in json_city for c in known_cities):
                                # Maybe format was "Venue Name, Something Else"
                                # Look for city in the whole string
                                found = False
                                for c in known_cities:
                                    if c in json_venue_full:
                                        json_city = c
                                        # Remove city from venue name if it's at the end
                                        if json_venue_full.endswith(c) or json_venue_full.endswith(f", {c}"):
                                            json_venue = (
                                                json_venue_full.replace(f", {c}", "").replace(c, "").strip().strip(",")
                                            )
                                        found = True
                                        break
                                if not found:
                                    # Default assumption
                                    pass

                            if json_venue:
                                venue = json_venue
                                # Update local variables and meta
                                self.logger.info(f"Updated Venue from JSON: {venue}")

                            if json_city:
                                city = json_city
                                self.logger.info(f"Updated City from JSON: {city}")

                        # Fallback logic for single price extraction (existing logic)
                        values = []
                        # Format could be Dict[ID, Dict] or Dict[ID, float] or List[Dict]
                        if isinstance(data, dict):
                            values = data.values()
                        elif isinstance(data, list):
                            values = data
                        else:
                            values = []

                        for val in values:
                            try:
                                # It might be a simple number or a dict
                                p = None
                                if isinstance(val, (int, float)):
                                    p = float(val)
                                elif isinstance(val, dict):
                                    # Look for likely keys
                                    for key in ["price", "satis_fiyati", "fiyat", "amount", "tutar"]:
                                        if key in val:
                                            p = float(str(val[key]).replace(",", "."))
                                            break
                                elif isinstance(val, str):
                                    # "672,00"
                                    p = float(val.replace(".", "").replace(",", "."))

                                if p is not None and p > 0:
                                    prices.append(p)
                            except Exception:
                                continue

                        if prices:
                            final_price = min(prices)
                            self.logger.info(f"✓ Extracted min price from JSON: {final_price}")
            except Exception as e:
                self.logger.debug(f"JSON price extraction failed: {e}")

            # Try 2: .price-info span (e.g. <span class="price-info" itemprop="price">550,00</span>)
            if not final_price and not is_sold_out:

                try:
                    # Added .ed-biletler__sehir__gun__fiyat based on user screenshot
                    # Try specific price span first (has content attribute)
                    price_el = await search_scope.query_selector('.price-info[itemprop="price"]')

                    # Fallback to global page if scoped search failed and we are scoped
                    if not price_el and search_scope != page:
                        price_el = await page.query_selector('.price-info[itemprop="price"]')
                        if price_el:
                            self.logger.info("✓ Found price in global scope (fallback)")

                    # If not found, try broader containers
                    if not price_el:
                        price_el = await search_scope.query_selector(".bilet-fiyati, .ed-biletler__sehir__gun__fiyat")

                    if price_el:
                        # Try 'content' attribute first (cleaner)
                        price_text = await price_el.get_attribute("content")
                        if price_text:
                            self.logger.info(f"✓ Found price in 'content' attribute: {price_text}")

                        # Fallback to text
                        if not price_text:
                            price_text = await price_el.inner_text()

                        if price_text:
                            # Clean "550,00 ₺" -> 550.00
                            # Remove dots (thousands), replace comma with dot, remove currency symbols
                            cleaned = (
                                price_text.replace(".", "").replace(",", ".").replace("TL", "").replace("₺", "").strip()
                            )
                            # Handle "Satın Al" or other non-price text
                            import re

                            match = re.search(r"(\d+(?:\.\d+)?)", cleaned)
                            if match:
                                final_price = float(match.group(1))
                                self.logger.info(f"✓ Found price for '{response.meta.get('title')}': {final_price}")
                            else:
                                self.logger.debug(f"Could not parse price from text: {price_text}")
                except Exception as e:
                    self.logger.debug(f"CSS price extraction failed: {e}")

            if not final_price and not is_sold_out:
                if not istanbul_container:
                    self.logger.warning(f"⚠️ Could not extract price for '{response.meta.get('title')}'")
                else:
                    self.logger.warning(f"⚠️ Found Istanbul container but no price inside.")
                    # DEBUG: Dump HTML to see what's wrong
                    try:
                        html_dump = await istanbul_container.inner_html()
                        self.logger.error(f"HTML DUMP for {response.meta.get('title')}: {html_dump[:500]}...")
                    except Exception as e:
                        self.logger.error(f"Failed to dump HTML: {e}")

            # Fallback for Cinema (Sinema) events
            # Cinema prices are hidden behind interactions, so we assume a default average
            event_type = response.meta.get("event_type") or "Etkinlik"
            if "sinema" in event_type.lower() or "sinema" in response.url.lower():
                self.logger.info("🎬 Cinema detected: Applying default price of 250.0 TL")
                final_price = 250.0

            # --- END PRICE EXTRACTION ---

            # Extract event date from detail page
            # Try multiple methods as the date might be in different places/formats
            event_date = response.meta.get("date_string")  # Use date from listing if available

            # Get rating from listing page metadata (already extracted)
            rating = response.meta.get("rating")
            rating_count = response.meta.get("rating_count")

            self.logger.info("DEBUG: Starting Date Extraction")
            # Only extract date if not already provided from listing
            if not event_date or not event_date.strip():
                # Method 1: Look for "Vizyon Tarihi" text (for cinema events)
                try:
                    # Scope this too
                    date_element = await search_scope.query_selector("text=Vizyon Tarihi")
                    if date_element:
                        full_text = await date_element.evaluate("el => el.parentElement.textContent")
                        # Extract date from "Vizyon Tarihi 28 Kasım 2025 Cuma"
                        if full_text and "Vizyon Tarihi" in full_text:
                            event_date = full_text.replace("Vizyon Tarihi", "").strip()
                except Exception:
                    pass

                # Method 2: Direct CSS selector if there's a specific class
                if not event_date:
                    try:
                        # Use search_scope to avoid getting other cities' dates
                        date_text = await search_scope.text_content(
                            ".vizyon-tarihi, .release-date, .event-date, .ed-biletler__sehir__gun__tarih, .etkinlik-tarih, .tarih", timeout=2000
                        )
                        if date_text:
                            event_date = date_text.strip()
                    except Exception:
                        pass

                # Method 2.5: Look for <time datetime="..."> tags (semantic HTML)
                if not event_date:
                    try:
                        time_el = await search_scope.query_selector("time[datetime]")
                        if time_el:
                            datetime_attr = await time_el.get_attribute("datetime")
                            if datetime_attr:
                                # datetime is often ISO format like 2025-12-15
                                event_date = datetime_attr
                                self.logger.info(f"✓ Extracted date from <time datetime>: {event_date}")
                            else:
                                # Fallback to text content
                                event_date = await time_el.text_content()
                                if event_date:
                                    event_date = event_date.strip()
                    except Exception:
                        pass

                # Method 3: Search page content for Turkish date patterns
                if not event_date:
                    all_text = await page.content()
                    # Look for Turkish month names in the content
                    turkish_months = [
                        "Ocak",
                        "Şubat",
                        "Mart",
                        "Nisan",
                        "Mayıs",
                        "Haziran",
                        "Temmuz",
                        "Ağustos",
                        "Eylül",
                        "Ekim",
                        "Kasım",
                        "Aralık",
                    ]

                    import re

                    # Try cinema-specific pattern first
                    for month in turkish_months:
                        if "Vizyon Tarihi" in all_text and month in all_text:
                            pattern = r"Vizyon Tarihi\s*([0-9]{1,2}\s+" + month + r"\s+[0-9]{4})"
                            match = re.search(pattern, all_text)
                            if match:
                                event_date = match.group(1).strip()
                                break

                    # If not found, try general date pattern (DD Month YYYY or DD - DD Month YYYY)
                    if not event_date:
                        for month in turkish_months:
                            if month in all_text:
                                # Pattern: "DD Month YYYY" or "DD - DD Month YYYY"
                                pattern = r"(\d{1,2}(?:\s*-\s*\d{1,2})?\s+" + month + r"\s+\d{4})"
                                match = re.search(pattern, all_text)
                                if match:
                                    event_date = match.group(1).strip()
                                    break

                    # If still not found, try without year (use current year)
                    if not event_date:
                        from datetime import datetime as dt
                        current_year = dt.now().year
                        for month in turkish_months:
                            if month in all_text:
                                # Pattern: "DD Month" without year
                                pattern = r"(\d{1,2}\s+" + month + r")(?!\s+\d{4})"
                                match = re.search(pattern, all_text)
                                if match:
                                    event_date = match.group(1).strip()
                                    event_date += f" {current_year}"
                                    break

                # Log if date extraction failed after all methods
                if not event_date:
                    self.logger.warning(f"⚠️ All date extraction methods failed for: {response.meta.get('title')}")

            # Extract reviews from detail page
            self.logger.info("DEBUG: Starting Review Extraction")
            reviews = await self.extract_reviews(page)
            self.logger.info("DEBUG: Review Extraction Finished")

            if reviews:
                self.logger.info(f"✓ Found {len(reviews)} reviews for '{response.meta.get('title')}'")

            else:
                self.logger.info("DEBUG: No reviews found.")

            # Get metadata from the request
            title = response.meta.get("title")
            if not title:
                try:
                    title = self.extract_title(await page.query_selector("body"))
                    if title:
                        title = self.clean_text(title)
                except:
                    pass
            if not title:
                title = "Unknown Title"
            venue = response.meta.get("venue")
            city = response.meta.get("city")
            url = response.meta.get("url")
            image_url = response.meta.get("image_url")
            event_type = response.meta.get("event_type", "Etkinlik")

            # Extract shared data (Description & Entities) ONCE for all variants
            self.logger.info("DEBUG: Starting Entity Extraction (Global)")
            description = await self.extract_description(page)
            entities = await self.extract_entities(page)

            # Yield events
            # TWO MODES:
            # 1. Tour Page (Multiple cities/dates in div[data-sehir] containers)
            # 2. Single Page (Global date/venue)

            # Check for Tour Page Containers
            tour_containers = await page.query_selector_all("div[data-sehir]")

            if tour_containers:
                self.logger.info(f"✓ Detected Tour Layout with {len(tour_containers)} city blocks")

                # Iterate over each city block
                for container in tour_containers:
                    # Extract City
                    city_val = await container.get_attribute("data-sehir")
                    if not city_val:
                        city_val = response.meta.get("city")  # Fallback

                    # Clean city (e.g. "İstanbul Avrupa" -> "İstanbul")
                    city_clean = self.clean_text(city_val)
                    if city_clean:
                        # Heuristic: Remove "Avrupa", "Anadolu", etc. if desired, or keep specific
                        pass

                    # Find all event rows in this city block
                    event_rows = await container.query_selector_all(".ed-biletler__sehir__gun")

                    for row in event_rows:
                        try:
                            # Extract Date
                            # <time datetime="..." class="ed-biletler__sehir__gun__tarih">
                            date_el = await row.query_selector(".ed-biletler__sehir__gun__tarih")
                            row_date_raw = await date_el.text_content() if date_el else None

                            # Parse the date to add year and normalize format
                            row_date = None
                            if row_date_raw:
                                parsed_dates = parse_turkish_date_range(row_date_raw.strip())
                                # Use first date if range was parsed
                                row_date = parsed_dates[0] if parsed_dates and parsed_dates[0] != row_date_raw.strip() else row_date_raw.strip()

                            # Extract Venue
                            # <a itemprop="location" title="Venue Name">
                            venue_el = await row.query_selector('a[itemprop="location"]')
                            row_venue = await venue_el.get_attribute("title") if venue_el else None

                            if not row_venue and venue_el:
                                # Fallback to text content
                                row_venue = await venue_el.text_content()

                            # Extract Price (specific to this row if available)
                            # <div class="ed-biletler__sehir__gun__fiyat">
                            price_el = await row.query_selector(".ed-biletler__sehir__gun__fiyat")
                            row_price = None
                            if price_el:
                                p_text = await price_el.text_content()
                                # Parse price logic (reuse or simplify)
                                if p_text:
                                    cleaned = (
                                        p_text.replace(".", "")
                                        .replace(",", ".")
                                        .replace("TL", "")
                                        .replace("₺", "")
                                        .strip()
                                    )
                                    import re

                                    match = re.search(r"(\d+(?:\.\d+)?)", cleaned)
                                    if match:
                                        row_price = float(match.group(1))

                            # Create Event Item
                            event_item = EventItem(
                                title=self.clean_text(title),
                                venue=self.clean_text(row_venue) if row_venue else self.clean_text(venue),
                                city=self.clean_text(city_clean),
                                date=self.clean_text(row_date),
                                price=row_price if row_price else final_price,
                                description=description,
                                extracted_entities=entities,
                                price_range=response.meta.get("price_range"),
                                category_prices=response.meta.get("category_prices"),
                                url=response.url,
                                image_url=image_url,
                                category=refined_category if refined_category else event_type,
                                genre=genre,
                                duration=duration,
                                source="biletinial",
                                rating=rating,
                                rating_count=rating_count,
                                reviews=reviews,
                                uuid=str(uuid.uuid4()),  # New UUID for each tour date
                                is_update_job=response.meta.get("is_update_job", False),
                            )
                            self.log_event(event_item)
                            yield event_item

                        except Exception as e:
                            self.logger.warning(f"Error parsing tour row: {e}")
                            continue

            # Fallback to Single Page Logic (if no tour containers OR if explicit single date found)
            elif event_date:
                self.logger.info(f"✓ Found standard date for '{title}': {event_date}")

                # Parse date range into individual dates
                individual_dates = parse_turkish_date_range(event_date)

                # Yield event for each date
                for individual_date in individual_dates:
                    event_item = EventItem(
                        title=self.clean_text(title),
                        venue=self.clean_text(venue) if venue else None,
                        city=self.clean_text(city) if city else None,
                        date=individual_date,
                        price=final_price,
                        description=description,  # Use pre-extracted description
                        extracted_entities=entities,  # Use pre-extracted entities
                        price_range=response.meta.get("price_range"),  # Pass price_range if available
                        category_prices=response.meta.get("category_prices"),  # Pass extracted category prices
                        url=response.url,
                        image_url=image_url,
                        # Use refined category if found, otherwise fallback to meta/Etkinlik
                        category=refined_category if refined_category else event_type,
                        genre=genre,
                        duration=duration,
                        source="biletinial",
                        rating=rating,
                        rating_count=rating_count,
                        reviews=reviews,
                        uuid=response.meta.get("uuid") or str(uuid.uuid4()),
                        is_update_job=response.meta.get("is_update_job", False),
                    )

                    self.log_event(event_item)
                    yield event_item
            else:
                self.logger.warning(f"⚠️  Could not find date for event: {title}")
                # Still yield the event but with empty date
                event_item = EventItem(
                    title=self.clean_text(title),
                    venue=self.clean_text(venue) if venue else None,
                    city=self.clean_text(city) if city else None,
                    date=None,
                    price=final_price,
                    description=description,
                    extracted_entities=entities,
                    url=url,
                    image_url=image_url,
                    category=refined_category if refined_category else event_type,
                    genre=genre,
                    duration=duration,
                    source="biletinial",
                    uuid=response.meta.get("uuid") or str(uuid.uuid4()),
                )
                yield event_item

        except Exception as e:
            self.logger.error(f"Error parsing event detail page: {e}")
            # Yield event with no date rather than losing it completely
            event_item = EventItem(
                title=self.clean_text(response.meta.get("title")),
                venue=self.clean_text(response.meta.get("venue")) if response.meta.get("venue") else None,
                city=response.meta.get("city"),
                date=None,
                price=None,  # Failed defaults to None
                url=response.meta.get("url"),
                image_url=response.meta.get("image_url"),
                category=response.meta.get("event_type", "Etkinlik"),
                genre=None,
                duration=None,
                source="biletinial",
                uuid=response.meta.get("uuid") or str(uuid.uuid4()),
            )
            yield event_item

        finally:
            await page.close()

    def extract_title(self, element):
        """Extract event title from element."""
        # Try city-specific layout: h2 > a
        title = element.css("h2 a::text").get()
        if title and title.strip():
            return title.strip()

        # Try kategori__etkinlikler layout: h3 > a
        title = element.css("h3 a::text").get()
        if title and title.strip():
            return title.strip()

        # Try concert/category layout: figcaption > span
        title = element.css("figcaption > span::text").get()
        if title and title.strip():
            return title.strip()

        return None

    def extract_venue(self, element):
        """Extract venue from element."""
        # Try city-specific layout
        venue = element.css("div.sehir-detay__liste__alt__adres::text").getall()
        if venue:
            venue_text = " ".join([v.strip() for v in venue if v.strip()])
            return venue_text

        # Try kategori__etkinlikler layout: address
        # Use ::text to get direct text, but address might contain img
        address_parts = element.css("address::text").getall()
        if address_parts:
            venue = " ".join([p.strip() for p in address_parts if p.strip()])
            if venue:
                return venue

        # Try concert/category layout: p.loca
        venue = element.css("p.loca::text").get()
        if venue and venue.strip():
            return venue.strip()

        return None

    def extract_city(self, element):
        """Extract city name from element."""
        # Try to extract city from address or specific badges
        # Look for city in address structure

        # 1. Try address container
        address = element.css("div.sehir-detay__liste__alt__adres::text").getall()
        if address:
            # Often "Venue Name - City" or just "Venue Name"
            # This is hard to parse reliably without structure, but we can try
            full_address = " ".join([a.strip() for a in address if a.strip()])
            # Heuristic: Known major cities
            cities = ["İstanbul", "Ankara", "İzmir", "Antalya", "Bursa", "Eskişehir"]
            for c in cities:
                if c in full_address:
                    return c

        return None

    def extract_date(self, element):
        """Extract event date from element."""
        # Date is in mobile date display with different HTML tags:
        # <span>03</span> <b>Aralık</b> <p>19:30</p>

        # Try city-specific layout first
        day = element.css("div.sehir-detay__liste-mobiltarih span::text").get()
        month = element.css("div.sehir-detay__liste-mobiltarih b::text").get()
        time = element.css("div.sehir-detay__liste-mobiltarih p::text").get()

        if day or month or time:
            # Combine available parts
            parts = [p.strip() for p in [day, month, time] if p and p.strip()]
            return " ".join(parts) if parts else None

        # Try kategori__etkinlikler layout: span after address
        # Date format: "Aralık - 03 - 07" with <br> separating multiple dates
        date_span = element.css("address ~ span::text").getall()
        if date_span:
            # Join all date parts and clean up whitespace
            date_text = " ".join([d.strip() for d in date_span if d.strip()])
            return date_text if date_text else None

        # Try concert/category layout (if different structure exists)
        date_text = element.css("figcaption time::text").get()
        if date_text and date_text.strip():
            return date_text.strip()

        return None

    def extract_url(self, element, response):
        """Extract event URL from element."""
        # Try city-specific layout: h2 > a href
        url = element.css("h2 a::attr(href)").get()
        if url:
            return response.urljoin(url)

        # Try kategori__etkinlikler layout: h3 > a href
        url = element.css("h3 a::attr(href)").get()
        if url:
            return response.urljoin(url)

        # Try concert/category layout: a::attr(href) (element itself is the link)
        url = element.css("::attr(href)").get()
        if url:
            return response.urljoin(url)

        return None

    def extract_image(self, element):
        """Extract event image URL from element."""
        # Image can be in data-src (lazy load) or src
        img_url = element.css("img::attr(data-src)").get() or element.css("img::attr(src)").get()
        if img_url and not img_url.startswith("data:"):
            if img_url.startswith("//"):
                return "https:" + img_url
            elif img_url.startswith("/"):
                return "https://biletinial.com" + img_url
            return img_url
        return None

    def extract_type(self, element):
        """Extract event type/category from element."""
        # Try city-specific layout: badge
        event_type = element.css("span.sehir-detay__liste__ust__tip::text").get()
        if event_type and event_type.strip():
            return event_type.strip()

        # Try concert/category layout: figcaption > small (first one)
        event_type = element.css("figcaption > small::text").get()
        if event_type and event_type.strip():
            return event_type.strip()

        return None

    def extract_rating(self, element):
        """Extract rating and review count from listing page element."""
        try:
            # Look for rating container: <div class="etkinlikler_container_puan_list">
            rating_container = element.css("div.etkinlikler_container_puan_list")

            if not rating_container:
                return None, None

            # Extract rating: <strong>"4,7"</strong>
            rating_text = rating_container.css("strong::text").get()
            if rating_text:
                rating_text = rating_text.strip().strip('"')
                # Convert Turkish decimal (comma) to float
                rating = float(rating_text.replace(",", "."))
            else:
                rating = None

            # Extract review count: <span>(1121 Yorum)</span>
            review_text = rating_container.css("span::text").get()
            if review_text:
                # Extract number from "(1121 Yorum)"
                import re

                match = re.search(r"\((\d+)\s*Yorum\)", review_text)
                rating_count = int(match.group(1)) if match else None
            else:
                rating_count = None

            return rating, rating_count

        except Exception as e:
            self.logger.debug(f"Error extracting rating: {e}")
            return None, None

    async def extract_reviews(self, page):
        """
        Extract reviews and AI summary from event detail page.
        Returns list of review dicts with: author, text, rating, content_type
        """
        try:
            reviews = []

            # First, click the "Yorumlar" (Comments) tab to load reviews
            try:
                comments_tab = await page.query_selector('a.goComments[title="Yorumlar"]')
                if comments_tab:
                    # Add timeout to prevent hanging if tab is not interactable
                    await comments_tab.click(timeout=5000)
                    await asyncio.sleep(2)  # Wait for reviews to load
                    self.logger.debug("Clicked on Comments tab")
            except Exception as e:
                self.logger.debug(f"Could not click Comments tab (timeout or error): {e}")

            # Click "Daha Fazla Yorum" (Load More Comments) button repeatedly to load all reviews
            max_clicks = 10  # Prevent infinite loop
            clicks = 0
            while clicks < max_clicks:
                try:
                    # Look for "Daha Fazla Yorum" button
                    load_more_button = await page.query_selector("text=Daha Fazla Yorum")
                    if load_more_button:
                        # Check if button is visible and clickable
                        is_visible = await load_more_button.is_visible()
                        if is_visible:
                            try:
                                # Add timeout to prevent hanging on click
                                await load_more_button.click(timeout=5000)
                                await asyncio.sleep(1.5)  # Wait for new reviews to load
                                clicks += 1
                                self.logger.debug(f"Clicked 'Load More' button ({clicks} times)")
                            except Exception as click_err:
                                self.logger.debug(f"Timeout or error clicking load more: {click_err}")
                                break
                        else:
                            break
                    else:
                        break
                except Exception as e:
                    self.logger.debug(f"No more reviews to load: {e}")
                    break

            if clicks > 0:
                self.logger.info(f"Loaded additional reviews by clicking 'Load More' {clicks} times")

            # Get page HTML content after loading all reviews
            content = await page.content()

            import re
            from scrapy.selector import Selector

            sel = Selector(text=content)

            # Extract AI-generated summary first
            # Pattern: <div class="yds_cinema_movie_yorum_person comment_editor comment_AI">
            #          <mark>biletinial AI</mark>
            #          <p>AI summary text...</p>
            ai_summary_container = sel.css(".comment_editor.comment_AI, .yds_cinema_movie_yorum_person.comment_AI")
            if ai_summary_container:
                ai_text = ai_summary_container.css("p::text").get()
                if ai_text and len(ai_text.strip()) > 20:
                    reviews.append({"author": "biletinial AI", "text": ai_text.strip(), "content_type": "ai_summary"})
                    self.logger.debug(f"Extracted AI summary: {ai_text[:80]}...")

            # Extract user reviews from comment containers
            # Pattern: <div class="yds_comment_container" id="comment_container">
            #          <div class="yds_cinema_movie_yorum_person">...</div>
            comment_containers = sel.css(".yds_comment_container .yds_cinema_movie_yorum_person")

            # Filter out AI comments (already extracted)
            user_comment_containers = [c for c in comment_containers if "comment_AI" not in c.get()]

            self.logger.debug(f"Found {len(user_comment_containers)} user comment elements")

            for comment_el in user_comment_containers:
                review_data = {}

                # Extract author name from various possible locations
                # Try: .yds_cinema_movie_yorum_person_attribute_name_rank, strong, mark tags
                author = comment_el.css(
                    ".yds_cinema_movie_yorum_person_attribute_name_rank::text, strong::text, mark::text"
                ).get()
                if author:
                    review_data["author"] = author.strip()

                # Extract review text from specific container
                # The first <p> often contains "SEYİRCİ" (Spectator) label, so we target the comment body
                text = comment_el.css(".yds_cinema_movie_yorum_person_attribute_satir p::text").get()

                if not text:
                    # Fallback: Try all paragraphs but filter out known labels
                    text_parts = comment_el.css("p::text").getall()
                    valid_parts = [t.strip() for t in text_parts if t.strip() and "SEYİRCİ" not in t]
                    text = " ".join(valid_parts).strip() if valid_parts else None

                if text:
                    review_data["text"] = text.strip()
                    review_data["content_type"] = "user_review"

                # Extract rating if available (some reviews may have individual ratings)
                rating_el = comment_el.css(
                    ".rating::text, .stars::text, .puan::text, .yds_cinema_movie_yorum_person_attribute_satir::text"
                ).get()
                if rating_el:
                    rating_match = re.search(r"(\d+[,\.]?\d*)", rating_el)
                    if rating_match:
                        review_data["rating"] = float(rating_match.group(1).replace(",", "."))

                # Only add review if it has actual text (more than 10 chars to avoid noise)
                if review_data.get("text") and len(review_data.get("text", "")) > 10:
                    reviews.append(review_data)
                    self.logger.debug(
                        f"Extracted user review from {review_data.get('author', 'Unknown')}: {review_data.get('text')[:50]}..."
                    )
                else:
                    self.logger.debug(
                        f"Skipping review from {review_data.get('author', 'Unknown')}: Text too short/empty (len={len(review_data.get('text', '')) if review_data.get('text') else 0})"
                    )

            if reviews:
                self.logger.info(f"Total extracted: {len(reviews)} reviews (AI summaries + user reviews)")

            return reviews if reviews else None

        except Exception as e:
            self.logger.warning(f"Error extracting reviews: {e}")
            import traceback

            self.logger.debug(f"Traceback: {traceback.format_exc()}")
            return None

    def clean_text(self, text):
        """Clean and normalize text."""
        if not text:
            return None
        return " ".join(text.split()).strip()

    async def extract_description(self, page):
        """Extract event description from detail page."""
        try:
            # Selector identified from user screenshot
            # The description is contained in .yds_cinema_movie_thread_info
            # We extract the full text of the container to ensure we capture all metadata
            # (Yazar, Yönetmen, Oyuncular, etc.) which might be in p tags or other elements.

            element = await page.query_selector(".yds_cinema_movie_thread_info")

            if element:
                text = await element.inner_text()
                if text and len(text.strip()) > 20:
                    return text.strip()

            # Fallback to other potential selectors if the main one fails
            fallback_selectors = [
                ".movie-detail-content",
                ".etkinlik-detay-aciklama",
                "#event-content",
                "div[itemprop='description']",
                ".event-description",
                ".aciklama-detay",
            ]
            for selector in fallback_selectors:
                el = await page.query_selector(selector)
                if el:
                    text = await el.inner_text()
                    if text and len(text.strip()) > 20:
                        return text.strip()

            return None

        except Exception as e:
            self.logger.warning(f"Error extracting description: {e}")
            return None

    async def errback_close_page(self, failure):
        """Handle errors by closing the page."""
        page = failure.request.meta.get("playwright_page")
        if page:
            await page.close()
        self.logger.error(f"Request failed: {failure.value}")

    async def extract_entities(self, page):
        """
        Extracts entities (actors, directors, etc.) from the page.
        Supports two layouts:
        1. Cinema/Standard: Text-based <p><strong>Role:</strong> Name</p>
        2. Theater/Concert: Card grid with implicit roles
        """
        # print(f"CRITICAL PRINT: EXTRACT_ENTITIES STARTING on {page.url}")
        # self.logger.error(f"!!!!! CRITICAL ERROR LOG !!!!! EXTRACT_ENTITIES_V2 STARTING on {page.url}")
        try:
            # 0. Check for "Kadro" tab and click if needed (for tabbed layouts like Concerts)
            try:
                kadro_tab = page.locator(".goActors")
                if await kadro_tab.is_visible():
                    self.logger.info(f"🖱️  Clicking 'Kadro' tab on {page.url} to reveal entities...")
                    await kadro_tab.click()
                    await asyncio.sleep(1)  # Wait for UI update
            except Exception:
                pass

            # 1. Wait for ANY known container to be present
            try:
                # Layout 1: .yds_cinema_movie_thread_info
                # Layout 2: .yds_cinema_movie_thread_person_details_flex (Theater cast)
                # Use state='attached' to detect even if hidden/not fully visible yet
                await page.wait_for_selector(
                    ".yds_cinema_movie_thread_info, .yds_cinema_movie_thread_person_details_flex",
                    timeout=5000,
                    state="attached",
                )
            except Exception:
                # Don't return empty yet! Let the JS logic try its best.
                self.logger.warning(f"⚠️ Primary entity container not found on {page.url}. Proceeding to JS fallback...")

            # 2. Execute extraction logic
            js_result = await page.evaluate(
                """() => {
                try {
                    const entities = [];
                    let debugText = "";
                    let foundLayout = "none";
                    
                    // --- LAYOUT 1: Cinema / Standard (Detailed Role Text) ---
                    const infoContainers = document.querySelectorAll('.yds_cinema_movie_thread_info, .yds_cinema_movie_thread_body');
                    if (infoContainers.length > 0) {
                        foundLayout = "cinema_text";
                        // ... existing logic for Layout 1 ...
                        let container = infoContainers[0];
                        
                        // Heuristic selection (same as before)
                        if (infoContainers.length > 1) {
                            let bestContainer = container;
                            let maxScore = -1;
                            infoContainers.forEach(c => {
                                let score = 0;
                                const text = c.textContent || "";
                                if (text.includes("Yazar") || text.includes("YAZAR")) score += 10;
                                if (text.includes("Yönetmen") || text.includes("YÖNETMEN")) score += 10;
                                if (text.includes("Oyuncu") || text.includes("OYUNCU")) score += 10;
                                if (text.length > 100) score += 1; 
                                if (score > maxScore) { maxScore = score; bestContainer = c; }
                            });
                            container = bestContainer;
                        }
                        
                        debugText = container.innerText;
                        
                        const roleMap = {
                            'YAZAR': 'WROTE', 'YAZAN': 'WROTE',
                            'YÖNETMEN': 'DIRECTED', 'YÖNETEN': 'DIRECTED', 'SAHNEYE KOYAN': 'DIRECTED',
                            'OYUNCULAR': 'ACTED_IN', 'OYUNCU': 'ACTED_IN', 'OYNAYANLAR': 'ACTED_IN',
                            'MÜZİK': 'COMPOSED', 'BESTECİ': 'COMPOSED',
                            'ORKESTRA ŞEFİ': 'CONDUCTED', 'ŞEF': 'CONDUCTED',
                            'SOLİST': 'PERFORMED_BY',
                            'ÇEVİRMEN': 'TRANSLATED', 'ÇEVİREN': 'TRANSLATED',
                            'UYARLAYAN': 'ADAPTED',
                            'KOREOGRAFİ': 'CHOREOGRAPHED'
                        };
                        
                        const paragraphs = container.querySelectorAll('p');
                        // DEBUG: Log first few paragraphs
                        paragraphs.forEach((p, idx) => {
                             if (idx < 5) debugText += " | P" + idx + ": " + p.textContent;
                        });

                        paragraphs.forEach(p => {
                            const strong = p.querySelector('strong');
                            if (strong) {
                                let rawKey = strong.textContent.trim();
                                let key = rawKey.replace(':', '').toLocaleUpperCase('tr-TR');
                                let role = null;
                                let isKeyInStrong = true;
                                
                                // 1. Check if role is in the strong tag (Standard Layout)
                                for (const [k, r] of Object.entries(roleMap)) {
                                    if (key.includes(k)) { role = r; break; }
                                }
                                
                                // 2. Fallback: Check entire paragraph text (Symphony Layout: "Şef: <strong>Name</strong>")
                                if (!role) {
                                    let fullText = p.textContent.replace(/\u00a0/g, ' ').trim();
                                    let fullKey = fullText.toLocaleUpperCase('tr-TR');
                                    for (const [k, r] of Object.entries(roleMap)) {
                                         // Check if keyword exists in text AND appears *before* the name (roughly)
                                        if (fullKey.includes(k)) { 
                                            role = r; 
                                            isKeyInStrong = false;
                                            break; 
                                        }
                                    }
                                }
                                
                                if (role) {
                                    let rawValue = "";
                                    if (isKeyInStrong) {
                                         // Standard: Role is strong, Value is next sibling(s)
                                        let nextNode = strong.nextSibling;
                                        while (nextNode) {
                                            if (nextNode.nodeType === 3) rawValue += nextNode.textContent;
                                            nextNode = nextNode.nextSibling;
                                        }
                                    } else {
                                         // Symphony: Role is prev text, Value is current strong text
                                         rawValue = strong.textContent.trim();
                                    }

                                    let value = rawValue.trim().replace(/^[\\s"']+|[\\s"']+$/g, '');
                                    if (value.length > 2) {
                                        const names = value.split(',').map(n => n.trim()).filter(n => n.length > 0);
                                        names.forEach(name => {
                                            entities.push({ 'name': name, 'role': role, 'raw': rawValue });
                                        });
                                    }
                                }
                            }
                        });
                    }
                    
                    // --- LAYOUT 2: Theater / Card Grid (Implicit Roles) ---
                    // "Kadro" (Cast) -> ACTED_IN
                    const castContainer = document.querySelector('.yds_cinema_movie_thread_person_details_flex');
                    if (castContainer) {
                        foundLayout = foundLayout === "none" ? "theater_cards" : foundLayout + "+theater_cards";
                        const actors = castContainer.querySelectorAll('.yds_cinema_movie_thread_person_details');
                        actors.forEach(a => {
                            const nameEl = a.querySelector('.yds_person_details p');
                            const name = nameEl ? nameEl.textContent.trim() : "";
                            if (name) {
                                entities.push({ 'name': name, 'role': 'ACTED_IN', 'raw': 'From Cast Grid' });
                            }
                        });
                    }
                    
                    // "Sahne Arkası" (Crew) -> CREW / UNKNOWN
                    const crewContainer = document.querySelector('.artist_section_list');
                    if (crewContainer) {
                        foundLayout = foundLayout === "none" ? "crew_list" : foundLayout + "+crew_list";
                        const crewMembers = crewContainer.querySelectorAll('.artist_section_list-artist');
                        crewMembers.forEach(div => {
                            const link = div.querySelector('div > a');
                            const span = div.querySelector('div > span');
                            const name = link ? link.textContent.trim() : "";
                            if (name) {
                                let role = 'CREW';
                                if (span) {
                                    const spanText = span.textContent.trim();
                                    // Map known Turkish roles if they appear in span
                                    // Otherwise default to CREW
                                    if (spanText !== "-" && spanText.length > 2) {
                                        // Simple mapping
                                        const lowerSpan = spanText.toLocaleLowerCase('tr-TR');
                                        if (lowerSpan.includes("yazar")) role = 'WROTE';
                                        else if (lowerSpan.includes("yönetmen")) role = 'DIRECTED';
                                        else if (lowerSpan.includes("senaryo")) role = 'WROTE';
                                        else if (lowerSpan.includes("müzik")) role = 'COMPOSED';
                                        else role = 'CREW'; // Keep generic if unknown
                                    }
                                }
                                entities.push({ 'name': name, 'role': role, 'raw': 'From Crew List' });
                            }
                        });
                    }

                    if (entities.length > 0) {
                         return { found: true, result: entities, debug: debugText, layout: foundLayout };
                    }

                // Return both result and debug text
                return { result: entities, debug: debugText, layout: foundLayout };
            } catch(e) { 
                return { result: [], debug: "JS ERROR: " + e.toString(), layout: "error" }; 
            }
        }
        """
            )

            # Handle new return format (dict instead of list)
            entities = []
            if isinstance(js_result, dict):
                entities = js_result.get("result", [])
                debug_info = js_result.get("debug", "")
                found_layout = js_result.get("layout", "unknown")

                # Log specific debug info for problematic layouts
                if "Şef" in debug_info or "Solist" in debug_info:
                    self.logger.info(f"🔍 JS DEBUG INFO: {debug_info[:500]}...")  # Log first 500 chars

                if entities:
                    self.logger.info(
                        f"⚡ Fast-Path ({found_layout}): Extracted {len(entities)} entities. Sample: {entities[:2]}"
                    )
                else:
                    self.logger.warning(f"DEBUG_ENTITY_FAIL: Layout {found_layout} found but 0 entities.")
                    self.logger.info(f"🔍 JS DEBUG INFO (FAIL): {debug_info[:1000]}...")  # Log first 1000 chars on fail

                self.logger.info(f"⚡ Fast-Path: Extracted {len(entities)} entities.")

            # 3. Fallback: Python Regex (for Stand-up / simple text layouts)
            if not entities and debug_info:
                # self.logger.info("DEBUG: Attempting Python Fallback (Regex)...")
                try:
                    import re  # Ensure re is available (locally or globally)

                    # Pattern 1: "[Name] Tek Kişilik Stand Up" / "[Name] Stand Up"
                    # Matches "Furkan Bozdağ Tek Kişilik Stand Up"
                    standup_match = re.search(
                        r"([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+)+)\s+(?:Tek\s+Kişilik\s+Stand\s+Up|Stand\s+Up)",
                        debug_info,
                    )
                    if standup_match:
                        name = standup_match.group(1).strip()
                        entities.append({"name": name, "role": "PERFORMED_BY", "raw": "Regex: Stand Up"})
                        self.logger.info(f"✨ Fallback Extracted (Stand-up): {name}")

                    # Pattern 2: "Sahne Alan: [Name]"
                    sahne_match = re.search(
                        r"Sahne\s+Alan\s*:\s*([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+)+)", debug_info
                    )
                    if sahne_match:
                        name = sahne_match.group(1).strip()
                        entities.append({"name": name, "role": "PERFORMED_BY", "raw": "Regex: Sahne Alan"})
                        self.logger.info(f"✨ Fallback Extracted (Sahne Alan): {name}")

                except Exception as ex:
                    self.logger.warning(f"Fallback regex error: {ex}")

            return entities

        except Exception as e:
            self.logger.warning(f"Error extracting entities logic: {e}")
            return []
