"""
Scrapes TekStack website content and stores it in the knowledge base.
Run manually: python scraper.py
Or triggered via the admin dashboard POST /api/scrape
"""
import asyncio
import re
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

import aiosqlite
from database import DB_PATH

START_URL = "https://www.tekstack.com"
MAX_PAGES = 50  # cap to avoid runaway scraping
SKIP_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".zip", ".mp4"}


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def is_same_domain(url: str, base: str) -> bool:
    return urlparse(url).netloc == urlparse(base).netloc


def extract_text(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "iframe"]):
        tag.decompose()
    text = soup.get_text(separator=" ")
    return clean_text(text)


async def scrape_site(status_callback=None) -> list[dict]:
    visited = set()
    queue = [START_URL]
    results = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        while queue and len(visited) < MAX_PAGES:
            url = queue.pop(0)
            if url in visited:
                continue
            parsed = urlparse(url)
            if any(parsed.path.lower().endswith(ext) for ext in SKIP_EXTENSIONS):
                continue
            visited.add(url)

            try:
                resp = await client.get(url, headers={"User-Agent": "TekStack-Max-Bot/1.0"})
                if resp.status_code != 200:
                    continue
                if "text/html" not in resp.headers.get("content-type", ""):
                    continue
            except Exception as e:
                print(f"Error fetching {url}: {e}")
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else url
            text = extract_text(soup)

            if len(text) > 100:
                results.append({"url": url, "title": clean_text(title), "content": text})
                if status_callback:
                    await status_callback(f"Scraped: {title[:60]}")

            # Collect internal links
            for a in soup.find_all("a", href=True):
                href = a["href"]
                full_url = urljoin(url, href).split("#")[0].split("?")[0]
                if (
                    is_same_domain(full_url, START_URL)
                    and full_url not in visited
                    and full_url not in queue
                ):
                    queue.append(full_url)

    return results


async def save_scraped_to_db(pages: list[dict]):
    async with aiosqlite.connect(DB_PATH) as db:
        # Deactivate old scraped entries
        await db.execute("UPDATE knowledge_entries SET active = 0 WHERE source = 'scraped'")
        for page in pages:
            await db.execute(
                """INSERT INTO knowledge_entries (source, url, title, content, active)
                   VALUES ('scraped', ?, ?, ?, 1)""",
                (page["url"], page["title"], page["content"][:8000])  # cap per page
            )
        await db.commit()


async def run_scrape(status_callback=None):
    if status_callback:
        await status_callback("Starting scrape of tekstack.com...")
    pages = await scrape_site(status_callback)
    await save_scraped_to_db(pages)
    if status_callback:
        await status_callback(f"Done. Saved {len(pages)} pages to knowledge base.")
    return len(pages)


if __name__ == "__main__":
    from database import init_db

    async def main():
        await init_db()

        async def log(msg):
            print(msg)

        count = await run_scrape(log)
        print(f"\nScraped {count} pages successfully.")

    asyncio.run(main())
