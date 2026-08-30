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
Reuse existing Paperless taxonomy + fill matching custom fields
        ↓
PATCH Paperless document
```

Codex extracts:

- searchable full document text
- title
- document date
- correspondent / sender
- recipient
- document type
- tags
- storage path (existing paths only)
- matching existing custom fields and their values
- language, short summary, confidence and warnings

## Existing metadata first

Before every scan the sidecar loads the current Paperless taxonomy and passes object IDs and names to Codex:

- correspondents
- document types
- tags
- storage paths
- custom fields

Codex is instructed to select an existing ID whenever it is semantically appropriate instead of proposing a slightly different name. The sidecar then performs another normalized similarity check before creating anything. For example `BKK Firmus`, `BKK firmus` or small punctuation/case variants should resolve to the same existing object.

`EXISTING_MATCH_THRESHOLD` controls the second-stage similarity guard. Missing correspondents, document types and tags may still be created when `CREATE_MISSING_METADATA=true`. Storage paths are never created automatically.

## Custom fields

The service loads `/api/custom_fields/` before every scan, including each field's ID, name, data type and select options. Codex may only fill fields that already exist in Paperless; it never creates new custom fields.

Supported automatic values include:

- string / text
- URL
- date
- boolean
- integer
- float
- monetary
- select using an existing select option ID

`documentlink` is deliberately not filled automatically.

Typical fields such as `Rechnungsnummer`, `Kundennummer`, `Vertragsnummer`, `Betrag`, `Fälligkeit`, `IBAN` or `Empfänger` can therefore be detected and filled when those fields exist in Paperless and the value is visible in the document. Existing non-empty custom-field values are protected by default; set `OVERWRITE_CUSTOM_FIELDS=true` only if Codex should be allowed to replace them.

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
- `EXISTING_MATCH_THRESHOLD=0.86`
- `OVERWRITE_CUSTOM_FIELDS=false`

## API

- `GET /health`
- `GET /status`
- `GET /metadata`
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
