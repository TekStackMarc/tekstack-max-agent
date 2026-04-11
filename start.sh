#!/bin/bash
echo "Starting TekStack Max Agent..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with your API key first!"
  exit 1
fi
pip install -r requirements.txt -q
python server.py
