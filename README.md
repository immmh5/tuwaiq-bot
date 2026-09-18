# 🤖 بوت طويق — المراقب الذكي

بوت يراقب منصة [طويق](https://sc.tuwaiq.edu.sa/) (LMS/EduQuest) ويرسل تنبيهات فورية على **تلجرام** عند:
- 📝 واجب جديد + موعد استحقاقه
- 📚 مادة/ملف تعليمي جديد
- 📄 اختبار متاح
- 🎯 نتيجة/درجة جديدة

## ✅ اشتغل وصار معروف (مو نظري)

كل التحديات التقنية تم حلها **وفحصها على الموقع الحقيقي**:

| التحدي | الحل |
|---|---|
| تسجيل الدخول | Keycloak OIDC مع **PKCE (S256)** — تمامًا مثل المتصفح |
| Cloudflare bot protection | نقل حركة الـ API عبر **curl** (Node TLS fingerprint يحجب) |
| جلوس البوت | **refresh token** + إعادة تسجيل دخول تلقائية + حماية login loop |
| تكرار التنبيهات | Postgres الخارجي يخزّن كل ما رُصد (dedup) |
| النوم على Render | pinger يضرب `/health` كل ٥ دقائق |

## 🚀 النشر على Render (10 دقائق)

### 1. قاعدة البيانات (مجانية للأبد)
- سجّل في [Supabase](https://supabase.com/) أو [Neon](https://neon.tech/)
- أنشئ مشروع، انسخ **Connection string** (صيغة `postgresql://...`)
- فعّل auto-suspend للـ Neon أو استخدم pooler في Supabase

### 2. البوت على Render
- **New → Web Service → Deploy an existing image** أو اربط هذا الـ repo (Docker)
- الإعدادات:
  - **Runtime**: Docker
  - **Plan**: Free
  - **Health Check Path**: `/health`
- متغيرات البيئة:

| المتغير | القيمة |
|---|---|
| `DATABASE_URL` | connection string من Supabase/Neon |
| `TELEGRAM_BOT_TOKEN` | توكنك من @BotFather |
| `TELEGRAM_CHAT_ID` | معرّف شاتك (رقمي) |
| `CONTROL_SECRET` | سر عشوائي طويل (للتحكم عن بعد عبر MCP) |
| `CHECK_INTERVAL_MIN` | `10` (افتراضي، ٥–١٢٠) |

ولّد سر قوي بأمر:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 3. منع النوم (لأن الباقة المجانية تنام)
Render free ينام بعد ١٥ دقيقة خمول. ثبّت pinger مجاني على [UptimeRobot](https://uptimerobot.com/) أو [cron-job.org](https://cron-job.org/):
- URL: `https://<your-service>.onrender.com/health`
- كل **٥ دقائق**

### 4. التشغيل
1. افتح رابط الخدمة → صفحة الدخول → أدخل إيميل وباسوورد طويق
2. البوت يسجّل الدخول على Keycloak، يخزّن الجلسة، ويبدأ المراقبة
3. رسالة تأكيد تصلك على تلجرام

## 💬 أوامر تلجرام

```
/status     — حالة الاتصال وآخر فحص
/check      — افحص الحين
/watch      — قائمة النطاقات
/watch assignments on|off  — تحكم بالنطاقات
/seen       — آخر ما رُصد
/due        — واجبات مستحقة خلال ٢٤ ساعة
/who        — الحساب الحالي
/reset      — مسح سجل المراقبة
/logout     — تسجيل خروج ومسح البيانات
```

النطاقات: `assignments` `materials` `exams` `grades`

## 🔒 الأمان

- الباسوورد **ما يمر عبر تلجرام** ولا يُسجّل في logs
- يُخزّن في قاعدة بياناتك الخاصة (Postgres external)
- `TELEGRAM_CHAT_ID` يحصر التحكم بشاتك أنت فقط
- الحساب يُحذف فورًا بأمر `/logout` أو من Render env

## 🛠 التطوير المحلي

```bash
docker run -d --name pg -e POSTGRES_USER=bot -e POSTGRES_PASSWORD=bot \
  -e POSTGRES_DB=bot -p 5432:5432 postgres:16-alpine

DATABASE_URL=postgresql://bot:bot@localhost:5432/bot \
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
npm start
```

> ملاحظة: النقل عبر curl ضروري لأن Cloudflare يحجب بصمة TLS الخاصة بـ Node.
> الـ Dockerfile مبنية على `node:24-trixie-slim` (curl 8.x + OpenSSL 3.5 = fingerprint مطابق للمتصفح).

## 📁 البنية

```
src/
├── index.js      — التشغيل: store + telegram + web + watcher
├── auth.js       — Keycloak PKCE login + token refresh
├── http.js       — نقل عبر curl (Cloudflare bypass)
├── tuwaiq.js     — واجهة API للطالب
├── store.js      — Postgres (kv + seen_items)
├── telegram.js   — بوت تلجرام (long polling)
├── watcher.js    — محرك المراقبة + التنبيهات
└── web.js        — صفحة الدخول + /health + API
```
