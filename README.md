# paperless-codex

Codex vision sidecar for Paperless-ngx. It downloads the actual document file from Paperless, renders PDFs to page images and lets Codex scan the pages directly. Paperless OCR text is not used as the AI input.

## Flow

```text
Paperless document added / bulk scan
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
Structured JSON + OCR confidence
        ↓
Reuse existing Paperless taxonomy + fill matching custom fields
        ↓
Compare Codex OCR with existing Paperless OCR
        ↓
PATCH Paperless document + provenance/status tags
```

Codex extracts searchable full text, title, document date, correspondent/sender, recipient, document type, tags, storage path, matching existing custom fields, language, summary, OCR confidence, overall confidence and warnings.

## Bulk scan

Pipeline 4 adds a bulk scanner for existing Paperless documents.

- newest documents first (`ordering=-added`)
- one document at a time
- optionally skips documents already processed by the current tool/pipeline/model provenance
- progress counters for processed, automatic, review, failed and skipped documents
- pause, resume and cancel controls
- existing retry/review logic is used for every document

The UI exposes this under **Alle Dokumente scannen**.

API:

- `GET /bulk/status`
- `POST /bulk/start` with `{ "skipCurrent": true }`
- `POST /bulk/pause`
- `POST /bulk/resume`
- `POST /bulk/cancel`

## Paperless menu without a fork

`paperless-codex.user.js` is a Tampermonkey userscript for `paperless.juloc.de`. It injects a native-looking **Codex** item directly below Documents in the Paperless sidebar. Paperless itself stays completely upstream and unmodified.

On the first click the script asks for the Codex UI URL and stores it in Tampermonkey. The URL can later be changed from the Tampermonkey menu with **Codex URL ändern**.

The Docker example intentionally binds the Codex UI to `127.0.0.1:8484` by default. Use an SSH tunnel, LAN-only bind or authenticated reverse proxy as appropriate; do not expose the management UI directly to the public internet.

## OCR improvement

Codex reads the rendered document pages directly and creates a fresh `fullText`. The prompt asks it to correct obvious OCR artifacts and broken line-end word splits while preserving the original meaning and exact identifiers.

Important identifiers such as invoice numbers, customer numbers, contract numbers, reference numbers, IBAN/BIC, amounts, dates, email addresses, phone numbers and addresses must be transcribed conservatively. Unreadable content is marked as `[unleserlich]` instead of being guessed.

With `OCR_REPLACE_MODE=better`, Paperless content is replaced only when the Codex OCR reaches `OCR_MIN_CONFIDENCE`, passes plausibility checks and is materially better or at least comparable and sufficiently complete. Existing non-empty OCR is backed up under `/data/state/ocr-backups/<document-id>.json` before replacement.

## Review and retry

- `AUTO_APPLY_CONFIDENCE=0.80`: metadata below this threshold is not written automatically and the document receives `AI Status: Review`.
- `MAX_RETRIES=2`: transient failures are retried twice after the initial attempt with exponential delay.
- Permanent failures receive `AI Status: Failed`.
- Successful automatic processing receives `AI Status: Processed`.

## AI / tool provenance

Processed documents can receive controlled Paperless tags describing the current processing provenance:

- `AI: Codex`
- `AI Tool: paperless-codex <version>`
- `AI Pipeline: <pipeline-version>`
- `AI Model: <resolved-or-configured-model>`
- `AI CLI: <codex-cli-version>`
- `AI OCR: improved` or `AI OCR: kept-existing`
- `AI Status: Pending|Processed|Review|Failed`

Old provenance/status tags are removed when a document is processed again. A persistent history of up to 20 runs per document is stored in `/data/state/provenance.json`, including document hash, versions, model, confidence, OCR decision and page count.

If `CODEX_MODEL` is explicitly set, model provenance is deterministic. If it is empty, the service tries to detect the resolved model from Codex JSON events and otherwise records `account-default`.

## Existing metadata first

Before every scan the sidecar loads correspondents, document types, tags, storage paths and custom fields from Paperless. Codex is instructed to select existing IDs whenever semantically appropriate. The sidecar performs a normalized similarity check before creating anything. Storage paths are never created automatically.

`EXISTING_MATCH_THRESHOLD` controls the second-stage similarity guard. Missing correspondents, document types and tags may be created when `CREATE_MISSING_METADATA=true`.

## Custom fields

The service discovers existing Paperless custom fields and may fill string/text, URL, date, boolean, integer, float, monetary and select values. `documentlink` is deliberately not filled automatically. Existing non-empty custom-field values are protected by default unless `OVERWRITE_CUSTOM_FIELDS=true`.

## PDF handling

The service downloads `/api/documents/{id}/download/?original=true` and falls back to the archived PDF when needed. PDFs are rendered with `pdftoppm` and passed directly to Codex as images.

Defaults:

- 50 MB document
- first 20 pages
- 150 DPI

## Authentication

The container installs the official `@openai/codex` CLI and persists `CODEX_HOME` in `/data/codex`. The included web UI provides the ChatGPT device-code login and status display.

## Paperless workflow

For newly added documents create a Paperless workflow:

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

## Environment

Required:

- `PAPERLESS_URL=http://webserver:8000`
- `PAPERLESS_TOKEN=<Paperless API token>`
- `BRIDGE_KEY=<random internal secret>`

Important optional settings:

- `PAPERLESS_CODEX_VERSION=0.1.2`
- `PAPERLESS_CODEX_PIPELINE_VERSION=4`
- `CODEX_MODEL=`
- `MIN_CONFIDENCE=0.55`
- `AUTO_APPLY_CONFIDENCE=0.80`
- `MAX_RETRIES=2`
- `RETRY_DELAY_MS=15000`
- `OCR_MIN_CONFIDENCE=0.70`
- `OCR_REPLACE_MODE=better`
- `WRITE_CONTENT=true`
- `CREATE_MISSING_METADATA=true`
- `EXISTING_MATCH_THRESHOLD=0.86`
- `OVERWRITE_CUSTOM_FIELDS=false`
- `PROVENANCE_TAGS=true`

## Security

- Codex is wrapped with `--disable shell_tool`.
- Scans use Codex sandbox `read-only`.
- The container can run read-only with `/tmp` as tmpfs and `/data/codex` + `/data/state` persisted.
- Do not expose the management UI directly to the public internet.

## Queue and state

Queued document IDs are stored under `/data/state/queue.json`. Persistent provenance is stored in `/data/state/provenance.json`; OCR backups are stored in `/data/state/ocr-backups/`.
