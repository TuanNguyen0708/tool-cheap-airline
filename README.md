# tool-cheap-airline

Tool CLI để săn tín hiệu khuyến mãi vé máy bay `0đ` từ các nguồn public.

## Thành phần chính

- `flight-zero-hunter.js` — hunter chính
- `flight-zero-sources.json` — cấu hình nguồn
- `flight-zero-watchlist.example.json` — mẫu cấu hình profile
- `telegram-alert-sender.js` — sender alert sang Telegram

## Yêu cầu

- Node.js 18+

## Cách chạy

### 1) Tạo watchlist riêng
```bash
cp flight-zero-watchlist.example.json flight-zero-watchlist.json
```

### 2) Chạy 1 profile
```bash
node flight-zero-hunter.js --profile dad-sgn-april --watchlist flight-zero-watchlist.json
```

### 3) Chạy tất cả profile
```bash
node flight-zero-hunter.js --all-profiles --watchlist flight-zero-watchlist.json --json
```

### 4) Quét định kỳ và ghi alert mới
```bash
node flight-zero-hunter.js --all-profiles --watchlist flight-zero-watchlist.json --watch --watch-every 600 --alert-file flight-alerts.jsonl
```

### 5) Gửi alert Telegram
```bash
export TELEGRAM_BOT_TOKEN=your_bot_token
export TELEGRAM_CHAT_ID=your_chat_id
node telegram-alert-sender.js --file flight-alerts.jsonl --truncate
```

## Ghi chú

Bản hiện tại là **promo hunter / alert pipeline**, chưa phải tool kiểm tra inventory thời gian thực hay auto-booking.

Phiên bản code đang ở nhánh cải tiến **v5A**: siết false positive bằng zero evidence + route evidence + source parser profile.
