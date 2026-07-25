FROM mcr.microsoft.com/playwright/python:v1.61.0-jammy

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

ENV WORKBOOK_STORAGE_ROOT=/data/projects
RUN mkdir -p /data/projects

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
