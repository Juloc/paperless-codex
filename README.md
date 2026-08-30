# paperless-codex

Sidecar service for Paperless-ngx that classifies newly added documents with Codex using a ChatGPT account session.

## Flow

1. Paperless-ngx consumes and OCRs a document.
2. A Paperless workflow (`Document Added`) sends a webhook with `{{doc_id}}`.
3. `paperless-codex` stores the document id in a persistent SQLite queue and returns immediately.
4. A worker fetches the document text and the existing Paperless taxonomy via REST.
5. Codex returns structured JSON for title, created date, correspondent, document type, tags, storage path and optional custom fields.
6. The sidecar validates the result and PATCHes only the selected metadata back to Paperless.

## Why a sidecar

Paperless remains unmodified and upgradeable. The sidecar can be stopped without affecting document ingestion. Slow Codex requests do not block the Paperless consumption process.

## Authentication

The service uses the official `openai-codex` Python SDK. Codex can authenticate with a ChatGPT-managed session. For a headless Docker host the service exposes a device-code login flow. The Codex home directory is persisted in a Docker volume so the session survives container restarts.

After deployment:

```bash
curl -X POST http://localhost:8484/api/auth/device/start
```

Open the returned `verification_url`, enter the `user_code`, then poll:

```bash
curl http://localhost:8484/api/auth/device/<login_id>
```

Check account state:

```bash
curl http://localhost:8484/api/auth/status
```

## Paperless workflow

Create a workflow in Paperless:

- Trigger: `Document Added`
- Action: `Webhook`
- URL: `http://paperless-codex:8484/webhook/paperless`
- Method/body encoding: JSON
- Header: `X-Paperless-Codex-Secret: <same secret as PAPERLESS_CODEX_WEBHOOK_SECRET>`
- Body:

```json
{
  "document_id": "{{doc_id}}"
}
```

The existing Paperless Docker network must be shared with this service.

## Environment

See `.env.example`.

Required:

- `PAPERLESS_URL` – internal Paperless URL, normally `http://webserver:8000`
- `PAPERLESS_TOKEN` – Paperless API token
- `PAPERLESS_CODEX_WEBHOOK_SECRET` – random shared webhook secret

Recommended defaults:

- existing taxonomy is preferred; missing correspondents/types/tags are not created automatically
- storage paths are never created automatically
- existing metadata is kept unless `PAPERLESS_CODEX_OVERWRITE=true`

## API

- `GET /health`
- `GET /api/auth/status`
- `POST /api/auth/device/start`
- `GET /api/auth/device/{login_id}`
- `POST /webhook/paperless`
- `POST /api/documents/{document_id}/enqueue`
- `GET /api/jobs`

## Security

Do not expose port `8484` publicly. Keep the service on the Paperless Docker network or behind an authenticated reverse proxy. Never commit the Paperless token or Codex credential directory.

## Status

Initial MVP. The first target is reliable text-based classification using Paperless OCR. Vision fallback for low-quality OCR can be added without changing the Paperless integration.