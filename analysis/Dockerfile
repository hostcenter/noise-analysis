FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends alsa-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY analysis/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY analysis/analyze.py /app/analyze.py
COPY models/ /app/models/

ENV LOG_DIR=/data/logs
CMD ["python", "analyze.py"]
