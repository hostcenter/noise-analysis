FROM python:3.11-slim

# tzdata: needed so heatmap hour-of-day respects TZ (localtime)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY dashboard/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY dashboard/dashboard.py /app/dashboard.py
COPY dashboard/static /app/static

# build timestamp (dd.mm.yyyy - hh:mm, UTC) shown in the sidebar footer;
# override with BUILD_DATE="$(git log -1 --format=%cd --date=format:'%d.%m.%Y - %H:%M')"
# to stamp the code date instead of the image build date
ARG BUILD_DATE=""
RUN printf '%s' "${BUILD_DATE:-$(date '+%d.%m.%Y - %H:%M')}" > /app/version.txt

ENV LOG_DIR=/data/logs
ENV DB_PATH=/data/logs/dashboard.db
CMD ["python", "dashboard.py"]
