FROM python:3.11-slim

# System deps for OpenCV / PaddleOCR / PyMuPDF
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# CPU-only slim deps for Docker (full CV stack: use requirements.txt on GPU hosts)
COPY requirements.docker.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY training ./training
RUN mkdir -p models

ENV AI_RASTER_DPI=200 AI_ENABLE_DWG=false AI_FALLBACK_PROVIDER=disabled
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
