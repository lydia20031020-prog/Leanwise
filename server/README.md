# Leanwise demo API

Node ESM + Express 5. All model calls use the official OpenAI SDK with the configured DeepSeek endpoint. The browser never receives the API key. Start from the project root with `npm run dev` (web + API) or `npm start` after `npm run build` (API + production frontend).

The server loads the project root `.env`. Set `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL=https://api.deepseek.com`, and `DEEPSEEK_MODEL=deepseek-flash`. The user example used `os.environ.get` with a secret as the variable name; this implementation uses a normal environment variable containing the key as its value. No key is committed or printed. Default API address is `http://127.0.0.1:8787`. Optional `PORT` and `HOST` override it. For website deployment, keep `HOST=127.0.0.1` and use the same-host Caddy reverse proxy. After a production build, Express serves `dist` assets and the web app's HTML routes; unknown `/api` routes still return a JSON 404.

## AI traffic limits and proxy configuration

Only actual DeepSeek SDK calls from `POST /api/analyze` and `POST /api/advice` consume a shared per-IP limit. Defaults are **10 calls per 60 seconds per IP** and **3 concurrent calls across all IPs**. Optional positive integer environment variables:

| Variable | Default | Allowed maximum |
| --- | --- | --- |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | `86400000` |
| `API_RATE_LIMIT_MAX` | `10` | `100000` |
| `API_MAX_CONCURRENT` | `3` | `1000` |

Invalid values use the defaults. Invalid requests, missing API configuration, status checks and health demo syncs do not consume AI allowance. An attempted provider call counts even when the provider fails. Rejected concurrent requests do not consume allowance, and concurrency is released when the provider call succeeds or fails. The fixed window starts on the IP's first admitted call; counters reset after the configured interval. Counters live in memory and reset on server restart. Expired IP counters are removed, and at most 10,000 IP buckets are retained. These limits apply to one Node process; multi-process deployments need a shared limiter.

For the supplied Caddy deployment only, set `LEANWISE_TRUST_PROXY=loopback` in the server `.env`. This explicitly enables Express's built-in `loopback` proxy trust, so only same-host proxy addresses are trusted and the nearest untrusted forwarded IP becomes the client IP. Without this exact setting, forwarded headers are ignored and the socket IP is used. Arbitrary strings such as `true` or `*` do not enable proxy trust. Keep the Node listener on loopback so public clients reach it through Caddy. The API has no user login; browser and mini program personal records remain on their own device, and the server does not persist food records, questions or request bodies. Traffic counters contain only an IP, count and reset time.

Rate rejection returns HTTP `429` with code `API_RATE_LIMIT`; a full global concurrency limit (or full IP counter capacity) returns HTTP `503` with code `API_BUSY`. Both return the standard Chinese error JSON and a `Retry-After` header in seconds. Normal manual editing and locally saved records are unaffected.

Model payload: `chat.completions.create({ model, messages, stream: false, reasoning_effort: 'high', thinking: { type: 'enabled' }, max_tokens: 6000 })`. JavaScript SDK custom body properties are sent directly (the Python equivalent is `extra_body`). Timeout 60 seconds, no automatic retries or model substitution. A configured key is not a verified connection; `/api/status` does not spend tokens or assert model access.

## Endpoints

### `GET /api/status`

```json
{"configured":false,"provider":"deepseek","model":"deepseek-flash","imageSupport":"unverified","healthMode":"demo"}
```

### `POST /api/analyze`

Request: `{ "text": "150ml 牛奶和一个鸡蛋", "image": "data:image/jpeg;base64,...", "memory": { "products": [], "recipes": [] } }`. `image` and `memory` are optional; at least one of text/image is required. Memory may alternatively be an array. Images must be base64 JPEG/PNG/WebP/GIF. The model must support vision; text-only models reject image requests and return a visible error. No substitute vision provider or fake image result is used.

Response:

```json
{
  "items": [{
    "id": "server-generated-uuid", "name": "用户确认的牛奶", "productId": "milk-product-id",
    "quantity": 150, "unit": "ml", "baseQuantity": 240, "baseUnit": "ml",
    "kcal": 160, "protein": 8, "carbs": 11, "fat": 9,
    "source": "memory", "confidence": "high"
  }],
  "note": "采用你的个人食品数据，请确认本次份量。", "provider": "deepseek"
}
```

Nutrition fields are **per `baseQuantity`/`baseUnit`**, not the consumed total. For the example, consumed energy is `160 × 150 / 240 = 100 kcal`. The frontend does this arithmetic in its shared calculation module. Units must match; milliliters are not silently converted to grams. Allowed units: `g`, `ml`, `个`, `份`, `杯`, `碗`, `片`, `勺`, `枚`. Sources: `memory`, `label`, `database`, `estimate`. Confidence: `high`, `medium`, `low`. New foods have `productId: null`. General model knowledge is an estimate, never a verified database lookup.

Model food output is parsed and validated before returning; invalid or missing nutrition is rejected rather than presented as zeros. Names, units, positive quantities, finite nonnegative nutrition and source/confidence are checked. Only an item declared `source: memory` with a known personal `productId` and matching units forcibly reuses the supplied confirmed name and nutrition; its current quantity is retained. The model cannot rewrite that nutrition. Unknown or incompatible memory matches return an explicit validation error. Label/current explicit data is never overwritten by old personal foods; non-memory items have `productId: null`. The API is stateless: saving confirmed records and personal food memory belongs to the frontend demo's local storage.

### `POST /api/advice`

Request: `{ "question": "今晚怎么吃？", "context": { ...currentGoals, ...calculatedData, ...recordHistory } }`. Context should contain the client date/time, completeness flag, actual goals, intake totals, body weight measurements/trend, source status and relevant records. Missing fields mean absent data, not zero.

Response: `{ "answer": "中文建议", "provider": "deepseek" }`. Prompt instructs the model to use real context, cite time ranges, distinguish incomplete days and simulated data, avoid fabricated records/extreme intake advice, and leave goals unchanged. This is lifestyle guidance, not medical diagnosis.

### `POST /api/health/demo-sync`

Request: `{ "source": "xiaomi" }` or `{ "source": "huawei" }`.

Response contains `source`, `sourceName`, `demo: true`, `connected: false`, `activeCalories`, `steps`, `timestamp`, `syncedAt`, `statisticsThrough`, `coverageUntil` (alias for `statisticsThrough`), `timezone: "Asia/Shanghai"`, and an explicit simulation `note`. This endpoint has **no real OAuth, device connection or health account read**. It exists to demonstrate source switching and data labels. Real integrations require separate vendor access approval and implementation.

## Errors and checks

Error response: `{ "error": "可以展示给用户的中文错误", "code": "STABLE_CODE", "recoverable": true }` with HTTP 400/402/413/422/429/502/503/504. Important codes: `API_NOT_CONFIGURED`, `API_RATE_LIMIT`, `API_BUSY`, `MODEL_UNAVAILABLE`, `IMAGE_NOT_SUPPORTED`, `PROVIDER_AUTH_ERROR`, `PROVIDER_BALANCE_INSUFFICIENT`, `PROVIDER_TIMEOUT`, `INVALID_MODEL_OUTPUT`, `INVALID_MEMORY_MATCH`, `INVALID_MEMORY_UNIT`. Provider errors are translated; raw messages and secrets are never returned.

Run backend checks with `node --test server/backend.test.js`. Tests use an injected mock SDK client and localhost HTTP, so they do not read or spend a real API key. They cover shared rate limits and reset, concurrency recovery after success/failure, missing configuration, forwarded-header spoofing, and production static/SPA routes in addition to provider and nutrition contracts. Live provider calls and actual model/image support need separate verification using the user's configured account.
