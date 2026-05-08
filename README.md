# QPay × Shopify (DRIFTHUB)

QPay v2 API-г Shopify-ийн дараах дэлгүүртэй холбох backend:

- **Primary domain:** `www.driftub.store`
- **Admin API host:** `drift-ub.myshopify.com` (.env-д энэ хаягийг тавина — байнгын тогтмол URL)
- **Other connected:** `m3ewjr-gk.myshopify.com`, `driftub.store`, `account.driftub.store`

## Архитектур

```
Customer → Shopify checkout (Manual Payment "QPay" сонгоно)
        → Shopify thank-you page (snippet ажиллана)
        → BACKEND/pay.html
        → POST /api/invoice/create  → QPay /v2/invoice  → QR харагдана
        → Customer мобайл банкаар төлнө
        → QPay → BACKEND/api/qpay/callback
                 ↓ (төлбөрийг /v2/payment/check-р баталгаажуулна)
                 ↓
              Shopify Admin API → orders/{id}/transactions (capture)
        → pay.html polling амжилт мэдэгдэнэ → Shopify-руу буцна
```

## Файлуудын тайлбар

| Файл | Зориулалт |
|---|---|
| `server.js` | Express backend, бүх API endpoint |
| `public/pay.html` | Customer-д харагдах QR төлбөрийн хуудас |
| `shopify-thankyou-snippet.html` | Shopify thank-you page-д тавих script |
| `.env.example` | Тохиргооны загвар |
| `render.yaml` | Render.com deploy config |

Дэлгэрэнгүй setup зааварчилгаа дотоод чат дотор бий.
