FROM python:3.11-slim

WORKDIR /app
COPY summarizer/summarize.py /app/summarize.py

ENV LOG_DIR=/data/logs
CMD ["python", "summarize.py"]
