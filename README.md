# paperless-codex

Codex vision sidecar for Paperless-ngx. It downloads the actual document file from Paperless, renders PDFs to page images and lets Codex scan the pages directly. Paperless OCR text is not used as the AI input.

## Flow

```text
Paperless document added
        ↓
Workflow webhook with {{doc_id}}
        ↓
paperless-codex persistent queue
        ↓
GET original file from Paperless API
        ↓
PDF → page PNGs with Poppler
(image files stay images)
        ↓
Codex CLI --image ...
ChatGPT device-code login
        ↓
Structured JSON
        ↓
PATCH Paperless document
```

Codex extracts:

- searchable full document text
- title
- document date
- correspondent
- document type
- tags
- storage path (existing paths only)
- language, short summary, confidence and warnings

Existing Paperless correspondents, document types, tags and storage paths are sent to Codex so it can reuse the existing taxonomy. Missing correspondents/document types/tags may be created automatically when `CREATE_MISSING_METADATA=true`.

## PDF handling

The service first downloads `/api/documents/{id}/download/?original=true`. If the original type is not directly scannable, it falls back to Paperless' archived PDF.

PDF pages are rendered with `pdftoppm` and passed directly to Codex as images. Default limits:

- 50 MB document
- first 20 pages
- 150 DPI

These limits are configurable.

## Authentication

The container installs the official `@openai/codex` CLI and persists `CODEX_HOME` in `/data/codex`.

Start ChatGPT device login:

```bash
curl -X POST \
  -H "X-Paperless-Codex-Key: $BRIDGE_KEY" \
  http://localhost:8484/auth/start
```

Open the returned `verificationUrl`, enter `userCode`, then query the returned session id:

```bash
curl \
  -H "X-Paperless-Codex-Key: $BRIDGE_KEY" \
  http://localhost:8484/auth/<session-id>
```

Status:

```bash
curl \
  -H "X-Paperless-Codex-Key: $BRIDGE_KEY" \
  http://localhost:8484/status
```

## Paperless workflow

Create a workflow:

- Trigger: `Document Added`
- Action: `Webhook`
- URL: `http://paperless-codex:8080/webhook/paperless`
- Encoding: JSON
- Header: `X-Paperless-Codex-Key` = same value as `BRIDGE_KEY`
- Body:

```json
{
  "document_id": "{{doc_id}}"
}
```

Paperless 3.x supports workflow webhooks and `{{doc_id}}`. The sidecar responds `202` immediately and processes the document in its own queue.

## Environment

See `.env.example`.

Required:

- `PAPERLESS_URL=http://webserver:8000`
- `PAPERLESS_TOKEN=<Paperless API token>`
- `BRIDGE_KEY=<random internal secret>`

Optional:

- `MAX_DOCUMENT_BYTES=52428800`
- `MAX_PAGES=20`
- `PDF_DPI=150`
- `CODEX_TIMEOUT_MS=360000`
- `CODEX_MODEL=`
- `MIN_CONFIDENCE=0.55`
- `WRITE_CONTENT=true`
- `CREATE_MISSING_METADATA=true`

## API

- `GET /health`
- `GET /status`
- `POST /auth/start`
- `GET /auth/{sessionId}`
- `POST /webhook/paperless`
- `POST /documents/{documentId}/scan`
- `GET /jobs`

All endpoints except `/health` require `X-Paperless-Codex-Key`.

## Security

- Codex is wrapped with `--disable shell_tool`.
- Scans run with Codex sandbox `read-only`.
- The service needs only a Paperless API token and its own bridge key.
- Do not expose the service directly to the internet.
- The Docker container can run read-only with `/tmp` as tmpfs and `/data/codex` + `/data/state` persisted.

## Queue

Queued document IDs are stored under `/data/state/queue.json`. The current document remains in that queue until processing finishes, so a container restart can resume it.