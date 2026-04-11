import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import anthropic
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db
from scraper import run_scrape

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
# Allow local dev + production origin
allowed_origins = [ALLOWED_ORIGIN, "http://localhost:3000", "http://127.0.0.1:3000"]

client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    yield


app = FastAPI(title="TekStack Max Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth ─────────────────────────────────────────────────────────────────────

def verify_admin(request: Request):
    auth = request.headers.get("X-Admin-Password", "")
    if auth != ADMIN_PASSWORD:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


# ── Request/Response models ───────────────────────────────────────────────────

class ChatRequest(BaseModel):
    conversation_id: str
    session_id: str
    message: str
    page_url: str = ""


class TrainingRequest(BaseModel):
    question_pattern: str
    preferred_response: str


class KnowledgeRequest(BaseModel):
    title: str = ""
    content: str
    url: str = ""


class SettingsPatch(BaseModel):
    timer_first_page: str | None = None
    timer_second_page: str | None = None
    booking_url: str | None = None
    agent_name: str | None = None
    scrape_urls: str | None = None


class TrackRequest(BaseModel):
    session_id: str
    url: str
    title: str = ""


# ── System prompt builder ─────────────────────────────────────────────────────

PERSONA = """You are Max, TekStack's friendly and knowledgeable website assistant.
You help visitors learn about TekStack's products and services with enthusiasm and clarity.

## Your Personality
- Warm, professional, and conversational — never robotic
- Concise: keep responses to 2-4 short paragraphs maximum
- Curious about the visitor's needs — ask follow-up questions
- Confident about TekStack's value without being pushy

## Connecting Visitors with Experts
When a visitor shows clear interest (asks about pricing, demos, trials, getting started, or wants to speak to someone),
offer to share a link to book time directly with the TekStack team. Say something natural like:
"I'd love to connect you with one of our product experts — they can give you a personalized walkthrough.
Want me to share a link to book a time that works for you?"

When you decide to share the booking link, output this exact token on its own line:
[CAPTURE_LEAD]

Then continue with a short friendly message like "Here's a link to book directly with our team — pick whatever time works best for you!"

## Guidelines
- Never make up facts about TekStack — if you don't know, say so honestly
- Don't discuss competitors negatively
- Keep the conversation focused on how TekStack can help them
- If asked something outside TekStack's scope, politely redirect

## Knowledge Base
"""


async def build_system_prompt(conn) -> str:
    knowledge = await db.get_active_knowledge(conn)
    overrides = await db.get_active_training_overrides(conn)

    prompt = PERSONA
    if knowledge:
        prompt += knowledge
    else:
        prompt += "(Knowledge base is being built — use general knowledge about TekStack from tekstack.com)"

    if overrides:
        prompt += "\n\n## Preferred Responses (follow these exactly when the question matches)\n"
        for o in overrides:
            prompt += f"\nQ pattern: {o['pattern']}\nA: {o['response']}\n"

    return prompt


# ── Chat endpoint ─────────────────────────────────────────────────────────────

async def stream_chat(chat: ChatRequest) -> AsyncGenerator[str, None]:
    conn = await db.get_db()
    try:
        await db.ensure_conversation(conn, chat.conversation_id, chat.session_id, chat.page_url)
        history = await db.get_conversation_messages(conn, chat.conversation_id)
        await db.save_message(conn, chat.conversation_id, "user", chat.message)

        system_prompt = await build_system_prompt(conn)
        messages = history + [{"role": "user", "content": chat.message}]

        full_response = ""
        lead_triggered = False

        async with client.messages.stream(
            model="claude-opus-4-6",
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                full_response += text

                # Check if [CAPTURE_LEAD] appeared in the accumulated text
                if not lead_triggered and "[CAPTURE_LEAD]" in full_response:
                    lead_triggered = True
                    # Send the lead capture event
                    yield f"data: {json.dumps({'type': 'lead_form'})}\n\n"
                    # Strip the token from what we stream to the user
                    full_response = full_response.replace("[CAPTURE_LEAD]", "")
                    continue

                # Don't send the trigger token itself
                if "[CAPTURE_LEAD]" not in text:
                    yield f"data: {json.dumps({'type': 'text', 'content': text})}\n\n"

        # Clean up the saved response
        clean_response = full_response.replace("[CAPTURE_LEAD]", "").strip()
        await db.save_message(conn, chat.conversation_id, "assistant", clean_response)

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except anthropic.APIError as e:
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
    finally:
        await conn.close()


@app.post("/api/chat")
async def chat(chat: ChatRequest):
    if not chat.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    return StreamingResponse(
        stream_chat(chat),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Public: Config ────────────────────────────────────────────────────────────

@app.get("/api/config")
async def get_config():
    conn = await db.get_db()
    try:
        settings = await db.get_settings(conn)
        raw_timer = int(settings.get("timer_first_page", 20))
        # Treat 0 or negative as default 20s (prevents instant open from accidental 0)
        timer = raw_timer if raw_timer > 0 else 20
        return {
            "timer_first_page": timer,
            "timer_second_page": int(settings.get("timer_second_page", 10)),
            "booking_url": settings.get("booking_url", ""),
            "agent_name": settings.get("agent_name", "Max"),
        }
    finally:
        await conn.close()


# ── Public: Page tracking ─────────────────────────────────────────────────────

@app.post("/api/track")
async def track_page(req: TrackRequest):
    conn = await db.get_db()
    try:
        await conn.execute(
            "INSERT INTO page_visits (session_id, url, title) VALUES (?, ?, ?)",
            (req.session_id, req.url, req.title)
        )
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


# ── Admin: Settings ───────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_settings_admin(request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        return await db.get_settings(conn)
    finally:
        await conn.close()


@app.patch("/api/settings")
async def update_settings(req: SettingsPatch, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        if req.timer_first_page is not None:
            await db.set_setting(conn, "timer_first_page", req.timer_first_page)
        if req.timer_second_page is not None:
            await db.set_setting(conn, "timer_second_page", req.timer_second_page)
        if req.booking_url is not None:
            await db.set_setting(conn, "booking_url", req.booking_url)
        if req.agent_name is not None:
            await db.set_setting(conn, "agent_name", req.agent_name)
        if req.scrape_urls is not None:
            await db.set_setting(conn, "scrape_urls", req.scrape_urls)
        return {"status": "ok"}
    finally:
        await conn.close()


# ── Admin: Page Visits ────────────────────────────────────────────────────────

@app.get("/api/page-visits")
async def get_page_visits(request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            "SELECT session_id, url, title, visited_at FROM page_visits ORDER BY visited_at DESC LIMIT 500"
        ) as cursor:
            rows = await cursor.fetchall()
        return [{"session_id": r[0], "url": r[1], "title": r[2], "visited_at": r[3]} for r in rows]
    finally:
        await conn.close()


# ── Admin: Conversations ──────────────────────────────────────────────────────

@app.get("/api/conversations")
async def list_conversations(request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            """SELECT c.id, c.session_id, c.page_url, c.visitor_name, c.visitor_email,
                      c.visitor_company, c.created_at, c.updated_at,
                      COUNT(m.id) as message_count
               FROM conversations c
               LEFT JOIN messages m ON m.conversation_id = c.id
               GROUP BY c.id
               ORDER BY c.updated_at DESC
               LIMIT 200"""
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            {
                "id": r[0], "session_id": r[1], "page_url": r[2],
                "visitor_name": r[3], "visitor_email": r[4], "visitor_company": r[5],
                "created_at": r[6], "updated_at": r[7], "message_count": r[8],
            }
            for r in rows
        ]
    finally:
        await conn.close()


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ) as cursor:
            convo = await cursor.fetchone()
        if not convo:
            raise HTTPException(status_code=404, detail="Not found")

        async with conn.execute(
            "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,)
        ) as cursor:
            msgs = await cursor.fetchall()

        return {
            "id": convo[0], "session_id": convo[1], "page_url": convo[2],
            "visitor_name": convo[3], "visitor_email": convo[4], "visitor_company": convo[5],
            "created_at": convo[6], "updated_at": convo[7],
            "messages": [{"role": m[0], "content": m[1], "created_at": m[2]} for m in msgs],
        }
    finally:
        await conn.close()


# ── Admin: Training ───────────────────────────────────────────────────────────

@app.get("/api/train")
async def list_overrides(request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            "SELECT id, question_pattern, preferred_response, active, created_at FROM training_overrides ORDER BY created_at DESC"
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            {"id": r[0], "question_pattern": r[1], "preferred_response": r[2],
             "active": bool(r[3]), "created_at": r[4]}
            for r in rows
        ]
    finally:
        await conn.close()


@app.post("/api/train")
async def add_override(req: TrainingRequest, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute(
            "INSERT INTO training_overrides (question_pattern, preferred_response) VALUES (?, ?)",
            (req.question_pattern, req.preferred_response),
        )
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


@app.delete("/api/train/{override_id}")
async def delete_override(override_id: int, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute("DELETE FROM training_overrides WHERE id = ?", (override_id,))
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


@app.patch("/api/train/{override_id}/toggle")
async def toggle_override(override_id: int, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute(
            "UPDATE training_overrides SET active = NOT active WHERE id = ?", (override_id,)
        )
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


# ── Admin: Knowledge ──────────────────────────────────────────────────────────

@app.get("/api/knowledge")
async def list_knowledge(request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            "SELECT id, source, url, title, LENGTH(content) as chars, active, created_at FROM knowledge_entries ORDER BY created_at DESC"
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            {"id": r[0], "source": r[1], "url": r[2], "title": r[3],
             "chars": r[4], "active": bool(r[5]), "created_at": r[6]}
            for r in rows
        ]
    finally:
        await conn.close()


@app.get("/api/knowledge/{entry_id}")
async def get_knowledge_entry(entry_id: int, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        async with conn.execute(
            "SELECT id, source, url, title, content, active FROM knowledge_entries WHERE id = ?",
            (entry_id,)
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        return {"id": row[0], "source": row[1], "url": row[2],
                "title": row[3], "content": row[4], "active": bool(row[5])}
    finally:
        await conn.close()


@app.post("/api/knowledge")
async def add_knowledge(req: KnowledgeRequest, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute(
            "INSERT INTO knowledge_entries (source, url, title, content) VALUES ('manual', ?, ?, ?)",
            (req.url, req.title, req.content),
        )
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


@app.delete("/api/knowledge/{entry_id}")
async def delete_knowledge(entry_id: int, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute("DELETE FROM knowledge_entries WHERE id = ?", (entry_id,))
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


@app.patch("/api/knowledge/{entry_id}/toggle")
async def toggle_knowledge(entry_id: int, request: Request, _=Depends(verify_admin)):
    conn = await db.get_db()
    try:
        await conn.execute(
            "UPDATE knowledge_entries SET active = NOT active WHERE id = ?", (entry_id,)
        )
        await conn.commit()
        return {"status": "ok"}
    finally:
        await conn.close()


# ── Admin: Scrape ─────────────────────────────────────────────────────────────

scrape_status = {"running": False, "log": []}


@app.post("/api/scrape")
async def trigger_scrape(request: Request, _=Depends(verify_admin)):
    if scrape_status["running"]:
        return {"status": "already_running"}

    scrape_status["running"] = True
    scrape_status["log"] = ["Starting scrape..."]

    async def do_scrape():
        async def log(msg):
            scrape_status["log"].append(msg)
        try:
            count = await run_scrape(log)
            scrape_status["log"].append(f"Complete — {count} pages scraped.")
        except Exception as e:
            scrape_status["log"].append(f"Error: {e}")
        finally:
            scrape_status["running"] = False

    asyncio.create_task(do_scrape())
    return {"status": "started"}


@app.get("/api/scrape/status")
async def scrape_status_endpoint(request: Request, _=Depends(verify_admin)):
    return scrape_status


# ── Serve admin dashboard & static files ──────────────────────────────────────

# Serve widget.js and widget.css with no-cache headers so browsers always get
# the latest version after deployments.
@app.get("/static/widget.js")
async def serve_widget_js():
    return FileResponse(
        "static/widget.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )

@app.get("/static/widget.css")
async def serve_widget_css():
    return FileResponse(
        "static/widget.css",
        media_type="text/css",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/admin")
async def admin_dashboard():
    return FileResponse("static/admin.html", headers={"Cache-Control": "no-store, no-cache"})


@app.get("/")
async def root():
    return {"status": "Max is running", "version": "1.0"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
