@echo off
echo Starting TekStack Max Agent...
if not exist .env (
    copy .env.example .env
    echo Created .env from .env.example - please edit it with your API key!
    pause
    exit /b 1
)
pip install -r requirements.txt --quiet
python server.py
