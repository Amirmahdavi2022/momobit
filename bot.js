// Momobit — a friendly Persian "file toolbox" Telegram bot.
// Runs on Render's free web service (Docker runtime) in webhook mode, so
// Telegram's own calls keep the service awake. ffmpeg does the media work.

import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// ---- config from the environment (never hard-code secrets) -----------------
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL || "@parsv2r"; // the channel users must join
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://t.me/parsv2r";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL; // Render sets this automatically

if (!TOKEN) {
  console.error("BOT_TOKEN is missing — set it in Render → Environment.");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Telegram bots can only download files up to 20 MB. Guard early so a user
// with a big file gets a clear message instead of a silent failure.
const MAX_BYTES = 20 * 1024 * 1024;

// Remember the last file each user sent, so the inline buttons know what to
// act on without stuffing a long file_id into 64-byte callback data.
const lastFile = new Map(); // userId -> { fileId, kind }

// ---------------------------------------------------------------------------
// Text (all Persian, warm and clear)
// ---------------------------------------------------------------------------
const BRAND = "🧰 Momobit";

function welcomeText(name) {
  return (
`✨ سلام ${name} عزیز، به ${BRAND} خوش اومدی!

من یه جعبه‌ابزار کوچولو برای فایل‌هاتم 🎒
هر کاری این پایین رو می‌تونم برات انجام بدم:

🖼 عکس → PDF
🗜 فشرده‌کردن عکس
🎵 گرفتن صدا از ویدیو (MP3)
🎬 فشرده‌کردن ویدیو

کافیه یه عکس یا ویدیو برام بفرستی،
خودم می‌پرسم باهاش چیکار کنم 😊`
  );
}

const GATE_TEXT =
`🔒 یه قدم کوچیک تا شروع!

برای استفاده از ${BRAND} اول باید عضو کانال ما بشی 🌟
بعد از عضویت، دکمه‌ی «✅ عضو شدم» رو بزن.`;

const HELP_TEXT =
`راهنمای ${BRAND} 📖

فقط فایلت رو بفرست، بقیه‌ش با من:

• یه *عکس* بفرست → می‌تونم PDFش کنم یا فشرده‌ش کنم
• یه *ویدیو* بفرست → می‌تونم صداشو (MP3) دربیارم یا حجمشو کم کنم

📌 نکته‌ها:
— حداکثر حجم فایل ۲۰ مگابایته (محدودیت خود تلگرامه)
— فشرده‌سازی ویدیو ممکنه یکی دو دقیقه طول بکشه، صبور باش 🙏`;

const mainMenuKb = () =>
  new InlineKeyboard()
    .text("🖼 راهنما", "help").row()
    .url("🌟 کانال ما", CHANNEL_LINK);

const gateKb = () =>
  new InlineKeyboard()
    .url("🌟 عضویت در کانال", CHANNEL_LINK).row()
    .text("✅ عضو شدم", "recheck");

// ---------------------------------------------------------------------------
// Membership gate
// ---------------------------------------------------------------------------
async function isMember(userId) {
  try {
    const m = await bot.api.getChatMember(CHANNEL, userId);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch (e) {
    // Almost always means the bot isn't an admin of the channel yet.
    console.error("getChatMember failed (is the bot an admin of the channel?):", e.description || e.message);
    return false;
  }
}

async function ensureMember(ctx) {
  if (await isMember(ctx.from.id)) return true;
  await ctx.reply(GATE_TEXT, { reply_markup: gateKb() });
  return false;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe helpers
// ---------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)),
    );
  });
}

function probeSize(path) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0:s=x",
      path,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const m = out.trim().match(/(\d+)x(\d+)/);
      resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1000, h: 1000 });
    });
    p.on("error", () => resolve({ w: 1000, h: 1000 }));
  });
}

// Build a minimal one-page PDF that embeds a JPEG at page size. Reliable and
// dependency-free: the JPEG is placed as an XObject scaled to the page.
function jpegToPdf(jpeg, w, h) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "binary");
    parts.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets[4] = pos;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `);
  push("/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ");
  push(`/Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefStart = pos;
  push(`xref\n0 6\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) {
    push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.concat(parts);
}

// Download a Telegram file to a local temp path.
async function download(ctx, fileId, dir, name) {
  const f = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = join(dir, name);
  await writeFile(path, buf);
  return path;
}

// ---------------------------------------------------------------------------
// The four jobs
// ---------------------------------------------------------------------------
async function jobImageToPdf(ctx, fileId) {
  const dir = await mkdtemp(join(tmpdir(), "mb-"));
  try {
    const src = await download(ctx, fileId, dir, "in");
    const jpg = join(dir, "out.jpg");
    await run("ffmpeg", ["-y", "-i", src, "-qscale:v", "3", jpg]);
    const { w, h } = await probeSize(jpg);
    const jpeg = await readFile(jpg);
    const pdf = jpegToPdf(jpeg, w, h);
    await ctx.replyWithDocument(new (await import("grammy")).InputFile(pdf, "momobit.pdf"), {
      caption: `✅ آماده شد!\n\n${BRAND}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function jobImageCompress(ctx, fileId) {
  const dir = await mkdtemp(join(tmpdir(), "mb-"));
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.jpg");
    // Cap the long edge at 1600px and re-encode as a lean JPEG.
    await run("ffmpeg", [
      "-y", "-i", src,
      "-vf", "scale='min(1600,iw)':-2",
      "-qscale:v", "6",
      out,
    ]);
    const buf = await readFile(out);
    const { InputFile } = await import("grammy");
    await ctx.replyWithDocument(new InputFile(buf, "momobit-compressed.jpg"), {
      caption: `✅ فشرده شد!\n\n${BRAND}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function jobVideoToMp3(ctx, fileId) {
  const dir = await mkdtemp(join(tmpdir(), "mb-"));
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp3");
    await run("ffmpeg", ["-y", "-i", src, "-vn", "-b:a", "192k", out]);
    const buf = await readFile(out);
    const { InputFile } = await import("grammy");
    await ctx.replyWithAudio(new InputFile(buf, "momobit.mp3"), {
      caption: `✅ صداش آماده شد!\n\n${BRAND}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function jobVideoCompress(ctx, fileId) {
  const dir = await mkdtemp(join(tmpdir(), "mb-"));
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp4");
    // Modest CRF + capped height keeps it inside 512MB / 0.1 CPU.
    await run("ffmpeg", [
      "-y", "-i", src,
      "-vf", "scale=-2:'min(720,ih)'",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ]);
    const buf = await readFile(out);
    const { InputFile } = await import("grammy");
    await ctx.replyWithVideo(new InputFile(buf, "momobit.mp4"), {
      caption: `✅ حجمش کم شد!\n\n${BRAND}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
bot.command("start", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply(welcomeText(ctx.from.first_name || "دوست من"), {
    reply_markup: mainMenuKb(),
  });
});

bot.command("help", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
});

bot.callbackQuery("help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
});

bot.callbackQuery("recheck", async (ctx) => {
  if (await isMember(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "خوش اومدی! 🎉" });
    try { await ctx.deleteMessage(); } catch {}
    await ctx.reply(welcomeText(ctx.from.first_name || "دوست من"), {
      reply_markup: mainMenuKb(),
    });
  } else {
    await ctx.answerCallbackQuery({
      text: "هنوز عضو نشدی 🙏 اول عضو کانال شو بعد این دکمه رو بزن.",
      show_alert: true,
    });
  }
});

function tooBig(sizeBytes) {
  return typeof sizeBytes === "number" && sizeBytes > MAX_BYTES;
}

// Photo (compressed image) or image sent as a document
bot.on([":photo", ":document"], async (ctx, next) => {
  if (!(await ensureMember(ctx))) return;

  const photo = ctx.message?.photo?.at(-1);
  const doc = ctx.message?.document;

  if (photo) {
    if (tooBig(photo.file_size)) return ctx.reply("😅 این عکس بزرگ‌تر از ۲۰ مگابایته.");
    lastFile.set(ctx.from.id, { fileId: photo.file_id, kind: "image" });
    return ctx.reply("با این عکس چیکار کنم؟ 👇", {
      reply_markup: new InlineKeyboard()
        .text("🖼 تبدیل به PDF", "do:img2pdf")
        .text("🗜 فشرده کن", "do:imgzip"),
    });
  }

  if (doc) {
    if (tooBig(doc.file_size)) return ctx.reply("😅 این فایل بزرگ‌تر از ۲۰ مگابایته.");
    const mime = doc.mime_type || "";
    if (mime.startsWith("image/")) {
      lastFile.set(ctx.from.id, { fileId: doc.file_id, kind: "image" });
      return ctx.reply("با این عکس چیکار کنم؟ 👇", {
        reply_markup: new InlineKeyboard()
          .text("🖼 تبدیل به PDF", "do:img2pdf")
          .text("🗜 فشرده کن", "do:imgzip"),
      });
    }
    if (mime.startsWith("video/")) {
      lastFile.set(ctx.from.id, { fileId: doc.file_id, kind: "video" });
      return ctx.reply("با این ویدیو چیکار کنم؟ 👇", {
        reply_markup: new InlineKeyboard()
          .text("🎵 گرفتن صدا (MP3)", "do:vid2mp3")
          .text("🎬 فشرده کن", "do:vidzip"),
      });
    }
    return ctx.reply("🤔 فعلاً فقط عکس و ویدیو رو بلدم. یه عکس یا ویدیو بفرست.");
  }
  return next();
});

bot.on(":video", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const v = ctx.message.video;
  if (tooBig(v.file_size)) return ctx.reply("😅 این ویدیو بزرگ‌تر از ۲۰ مگابایته.");
  lastFile.set(ctx.from.id, { fileId: v.file_id, kind: "video" });
  return ctx.reply("با این ویدیو چیکار کنم؟ 👇", {
    reply_markup: new InlineKeyboard()
      .text("🎵 گرفتن صدا (MP3)", "do:vid2mp3")
      .text("🎬 فشرده کن", "do:vidzip"),
  });
});

const JOBS = {
  img2pdf: { need: "image", label: "دارم PDF می‌سازم", run: jobImageToPdf },
  imgzip:  { need: "image", label: "دارم فشرده می‌کنم", run: jobImageCompress },
  vid2mp3: { need: "video", label: "دارم صداشو درمیارم", run: jobVideoToMp3 },
  vidzip:  { need: "video", label: "دارم حجمشو کم می‌کنم (کمی صبر کن)", run: jobVideoCompress },
};

bot.callbackQuery(/^do:(.+)$/, async (ctx) => {
  const job = JOBS[ctx.match[1]];
  if (!job) return ctx.answerCallbackQuery();
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: "اول عضو کانال شو 🙏", show_alert: true });
  }
  const item = lastFile.get(ctx.from.id);
  if (!item || item.kind !== job.need) {
    return ctx.answerCallbackQuery({
      text: "فایلش رو پیدا نکردم 😅 یه بار دیگه بفرستش.",
      show_alert: true,
    });
  }
  await ctx.answerCallbackQuery();
  const status = await ctx.reply(`⏳ ${job.label}…`);
  try {
    await ctx.replyWithChatAction(
      job.need === "video" ? "upload_video" : "upload_document",
    );
    await job.run(ctx, item.fileId);
  } catch (e) {
    console.error("job failed:", e.message);
    await ctx.reply("😔 یه مشکلی پیش اومد. لطفاً یه بار دیگه امتحان کن یا فایل کوچیک‌تری بفرست.");
  } finally {
    try { await ctx.api.deleteMessage(status.chat.id, status.message_id); } catch {}
  }
});

// Any other message → gentle nudge
bot.on("message", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply("یه عکس یا ویدیو برام بفرست تا کارشو انجام بدم 😊", {
    reply_markup: mainMenuKb(),
  });
});

bot.catch((err) => console.error("bot error:", err.error?.message || err.message));

// ---------------------------------------------------------------------------
// Webhook server (keeps the Render service awake via Telegram's own calls)
// ---------------------------------------------------------------------------
const SECRET = "momobit-hook";
const handle = webhookCallback(bot, "http", { secretToken: SECRET });

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === `/${SECRET}`) {
    try {
      return await handle(req, res);
    } catch (e) {
      console.error("webhook error:", e.message);
      res.statusCode = 200; // never make Telegram retry-storm us
      return res.end("ok");
    }
  }
  res.statusCode = 200;
  res.end("Momobit is running.");
});

server.listen(PORT, async () => {
  console.log(`listening on ${PORT}`);
  if (PUBLIC_URL) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/${SECRET}`;
    try {
      await bot.api.setWebhook(hook, { secret_token: SECRET, drop_pending_updates: true });
      const me = await bot.api.getMe();
      console.log(`webhook set for @${me.username} → ${hook}`);
    } catch (e) {
      console.error("setWebhook failed:", e.description || e.message);
    }
  } else {
    console.error("RENDER_EXTERNAL_URL missing — webhook not set. (Fine for local runs.)");
  }
});
