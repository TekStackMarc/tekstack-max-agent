import aiosqlite
import asyncio
import os

DB_PATH = os.getenv("DB_PATH", "max_agent.db")


async def get_db():
    return await aiosqlite.connect(DB_PATH)


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                page_url TEXT,
                visitor_name TEXT,
                visitor_email TEXT,
                visitor_company TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );

            CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT,
                name TEXT NOT NULL,
                company TEXT,
                email TEXT NOT NULL,
                preferred_time TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                contacted INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS training_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_pattern TEXT NOT NULL,
                preferred_response TEXT NOT NULL,
                active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS knowledge_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                url TEXT,
                title TEXT,
                content TEXT NOT NULL,
                active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS page_visits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Insert default settings if not exist
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            ("timer_first_page", "20")
        )
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            ("timer_second_page", "10")
        )
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            ("booking_url", "https://outlook.office.com/book/TekStackMeeting@tekstack.com/?ismsaljsauthenabled")
        )

        await db.commit()


async def get_conversation_messages(db, conversation_id: str) -> list[dict]:
    async with db.execute(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        (conversation_id,)
    ) as cursor:
        rows = await cursor.fetchall()
    return [{"role": row[0], "content": row[1]} for row in rows]


async def save_message(db, conversation_id: str, role: str, content: str):
    await db.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
        (conversation_id, role, content)
    )
    await db.execute(
        "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (conversation_id,)
    )
    await db.commit()


async def ensure_conversation(db, conversation_id: str, session_id: str, page_url: str):
    async with db.execute(
        "SELECT id FROM conversations WHERE id = ?", (conversation_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        await db.execute(
            "INSERT INTO conversations (id, session_id, page_url) VALUES (?, ?, ?)",
            (conversation_id, session_id, page_url)
        )
        await db.commit()


async def get_active_knowledge(db) -> str:
    async with db.execute(
        "SELECT title, content FROM knowledge_entries WHERE active = 1 ORDER BY created_at ASC"
    ) as cursor:
        rows = await cursor.fetchall()
    if not rows:
        return ""
    parts = []
    for title, content in rows:
        if title:
            parts.append(f"## {title}\n{content}")
        else:
            parts.append(content)
    return "\n\n".join(parts)


async def get_active_training_overrides(db) -> list[dict]:
    async with db.execute(
        "SELECT question_pattern, preferred_response FROM training_overrides WHERE active = 1"
    ) as cursor:
        rows = await cursor.fetchall()
    return [{"pattern": row[0], "response": row[1]} for row in rows]


async def get_settings(db) -> dict:
    async with db.execute("SELECT key, value FROM settings") as cursor:
        rows = await cursor.fetchall()
    defaults = {
        "timer_first_page": "20",
        "timer_second_page": "10",
        "booking_url": "https://outlook.office.com/book/TekStackMeeting@tekstack.com/?ismsaljsauthenabled",
    }
    result = dict(defaults)
    for key, value in rows:
        result[key] = value
    return result


async def set_setting(db, key: str, value: str):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        (key, value)
    )
    await db.commit()
