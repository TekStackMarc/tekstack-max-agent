# Deploying Max — TekStack Chat Agent

## Overview

The system has two parts:
1. **Backend** — Python/FastAPI server you host (handles AI, logs, leads)
2. **Widget** — A `<script>` tag you add to WordPress (no plugin needed)

---

## Step 1: Deploy the Backend

### Option A: Railway (Recommended — free tier available)

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Upload this folder to a GitHub repo first, then connect it
4. Set these environment variables in Railway's dashboard:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
   | `ADMIN_PASSWORD` | A strong password for the admin dashboard |
   | `ALLOWED_ORIGIN` | `https://www.tekstack.com` |

5. Railway will auto-detect the `Procfile` and deploy
6. Note your deployment URL (e.g. `https://max-agent.up.railway.app`)

### Option B: Render (also free tier)

1. Go to [render.com](https://render.com) → New Web Service
2. Connect your GitHub repo
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn server:app --host 0.0.0.0 --port $PORT`
5. Add the same environment variables as above

### Option C: Run Locally (for testing)

```bash
cd tekstack-max-agent
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY
pip install -r requirements.txt
python server.py
# Runs at http://localhost:8000
```

---

## Step 2: Seed Max's Knowledge Base

Once the backend is running, go to your Admin Dashboard and run the scraper:

1. Open `https://YOUR-BACKEND-URL/admin`
2. Log in with your `ADMIN_PASSWORD`
3. Go to **Knowledge** → click **Start Scrape**
4. Wait ~2 minutes for it to crawl tekstack.com
5. All content is now in Max's knowledge base

You can also manually add knowledge entries (FAQs, pricing details, etc.) anytime.

---

## Step 3: Add Max to WordPress

### Using "Insert Headers and Footers" Plugin (Easiest)

1. In WordPress Admin → **Plugins → Add New**
2. Search for **"Insert Headers and Footers"** by WPBeginner → Install & Activate
3. Go to **Settings → Insert Headers and Footers**
4. Paste this into the **Footer** box:

```html
<script
  src="https://YOUR-BACKEND-URL/static/widget.js"
  data-max-url="https://YOUR-BACKEND-URL">
</script>
```

5. Replace `YOUR-BACKEND-URL` with your Railway/Render URL
6. Click **Save**

Max will now appear on every page of tekstack.com automatically.

### Alternative: Add to Theme

In WordPress Admin → **Appearance → Theme Editor → footer.php**

Add before `</body>`:
```html
<script src="https://YOUR-BACKEND-URL/static/widget.js" data-max-url="https://YOUR-BACKEND-URL"></script>
```

---

## Step 4: Verify It Works

1. Visit `https://www.tekstack.com` in a fresh browser tab
2. Wait 20 seconds — Max should appear automatically
3. Navigate to a second page — Max will appear after 10 seconds
4. Check `https://YOUR-BACKEND-URL/admin` to see the conversation logged

---

## Admin Dashboard Features

| Feature | How to use |
|---|---|
| **View conversations** | Conversations tab → click "View" on any row |
| **See leads** | Leads tab — export as CSV anytime |
| **Mark lead contacted** | Leads tab → "✓ Mark contacted" |
| **Add training override** | Training tab — paste question pattern + ideal response |
| **Use conversation as training** | View a conversation → "Use as training example" |
| **Add knowledge manually** | Knowledge tab → Add Manual Entry |
| **Re-scrape website** | Knowledge tab → Start Scrape |

---

## Customizing Max's Appearance

Edit `static/widget.css` — the key variables are at the top:

```css
/* Change the blue to match TekStack brand */
background: linear-gradient(135deg, #0052cc 0%, #0073e6 100%);
```

After editing, redeploy or restart the server.

---

## Customizing Max's Persona

Edit the `PERSONA` constant at the top of `server.py`:

```python
PERSONA = """You are Max, TekStack's friendly and knowledgeable website assistant...
```

Add specific talking points, pricing guidance, or any context you want Max to always know.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | From console.anthropic.com |
| `ADMIN_PASSWORD` | Yes | Protects the /admin dashboard |
| `ALLOWED_ORIGIN` | Yes | `https://www.tekstack.com` |
| `PORT` | No | Defaults to 8000 |
| `DB_PATH` | No | SQLite file path, defaults to `max_agent.db` |

---

## Costs

- **Claude API**: ~$0.01–0.05 per conversation (Opus 4.6 model)
- **Hosting**: Railway/Render free tiers work for moderate traffic
- **No other dependencies** — SQLite is file-based, no database to manage
