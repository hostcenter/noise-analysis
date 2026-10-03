FROM python:3.11-slim

# tzdata: needed so heatmap hour-of-day respects TZ (localtime)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY dashboard/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY dashboard/dashboard.py /app/dashboard.py
COPY analysis/purge_events.py /app/purge_events.py
COPY dashboard/static /app/static

# sidebar version stamp = date of the committed code; dashboard/version.txt
# is refreshed by the post-commit hook (.githooks/, enable with
# git config core.hooksPath .githooks) and travels with the repo
COPY dashboard/version.txt /app/version.txt

ENV LOG_DIR=/data/logs
ENV DB_PATH=/data/logs/dashboard.db
CMD ["python", "dashboard.py"]
