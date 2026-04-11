import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = supabaseServiceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const TAGLINE_BY_LANG = {
  uz: 'Narxni bil, pulni teja',
  ru: 'Знай цену, экономь деньги',
  en: 'Know the price, save the money',
};

function resolveLang(languageCode) {
  if ((languageCode || '').startsWith('ru')) return 'ru';
  if ((languageCode || '').startsWith('en')) return 'en';
  return 'uz';
}

export function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

export async function sendBotMessage(chatId, text, extra = {}) {
  if (!TELEGRAM_TOKEN) return false;
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...extra,
  });
  return true;
}

export function withTagline(message, languageCode) {
  const lang = resolveLang(languageCode);
  const tagline = TAGLINE_BY_LANG[lang] || TAGLINE_BY_LANG.uz;
  return `${message}\n\n_${tagline}_ 💚`;
}

function buildWeeklyMessage(user, stats, weeklyReceipts, peopleHelped) {
  const lang = resolveLang(user?.language_code);
  const firstName = user?.first_name || (lang === 'ru' ? 'друг' : lang === 'en' ? 'friend' : 'do\'st');

  if (lang === 'ru') {
    return (
      `👋 Здравствуйте, ${firstName}!\n\n` +
      `📊 Ваш недельный отчет Narxi:\n\n` +
      `🧾 Отправлено чеков: ${weeklyReceipts || 0}\n` +
      `👥 Ваши данные помогли: ${peopleHelped || 0} людям\n` +
      `🔥 Серия: ${stats?.current_streak_weeks || 0} недель\n\n` +
      `💡 Совет на следующую неделю:\nПроверьте цены в соседнем районе, часто разница 10-20%\n\n` +
      `👉 @NarxiUzbBot`
    );
  }

  if (lang === 'en') {
    return (
      `👋 Hi, ${firstName}!\n\n` +
      `📊 Your Narxi weekly report:\n\n` +
      `🧾 Receipts submitted: ${weeklyReceipts || 0}\n` +
      `👥 Your data helped: ${peopleHelped || 0} people\n` +
      `🔥 Streak: ${stats?.current_streak_weeks || 0} weeks\n\n` +
      `💡 Tip for next week:\nCheck nearby districts, prices often vary by 10-20%\n\n` +
      `👉 @NarxiUzbBot`
    );
  }

  return (
    `👋 Assalomu alaykum, ${firstName}!\n\n` +
    `📊 Bu haftangiz Narxi hisoboti:\n\n` +
    `🧾 Yuborgan cheklar: ${weeklyReceipts || 0} ta\n` +
    `👥 Sizning ma'lumotlaringiz ${peopleHelped || 0} kishiga yordam berdi\n` +
    `🔥 Ketma-ket: ${stats?.current_streak_weeks || 0} hafta\n\n` +
    `💡 Keyingi hafta maslahati:\nYaqin hududlardagi narxlarni ham tekshirib turing\n\n` +
    `👉 @NarxiUzbBot`
  );
}

export async function sendPersonalWeeklyReport(user, weekNumber, year) {
  if (!supabase || !user?.telegram_id) return false;

  const [{ data: stats }, { count: weeklyReceipts }, { count: peopleHelped }] = await Promise.all([
    supabase.from('user_stats').select('*').eq('telegram_id', user.telegram_id).maybeSingle(),
    supabase
      .from('receipt_queue')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_id', user.telegram_id)
      .gte('created_at', getStartOfWeek()),
    supabase
      .from('product_views')
      .select('id', { count: 'exact', head: true })
      .eq('week_number', weekNumber)
      .eq('year', year),
  ]);

  const base = buildWeeklyMessage(user, stats, weeklyReceipts, peopleHelped);
  await sendBotMessage(user.telegram_id, withTagline(base, user.language_code), { parse_mode: 'Markdown' });
  return true;
}

export async function sendWeeklyReports() {
  if (!supabase) return { sentCount: 0, totalUsers: 0 };

  const { data: users } = await supabase
    .from('user_profiles')
    .select('telegram_id, first_name, preferred_city, language_code');

  const currentWeek = getWeekNumber(new Date());
  const currentYear = new Date().getFullYear();

  let sentCount = 0;
  for (const user of users || []) {
    try {
      const ok = await sendPersonalWeeklyReport(user, currentWeek, currentYear);
      if (ok) sentCount += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.error(`Failed to send report to ${user.telegram_id}:`, error?.message || error);
    }
  }

  return { sentCount, totalUsers: (users || []).length };
}

export async function sendBroadcast(message, scheduledId = null) {
  if (!supabase) return { sentCount: 0, totalUsers: 0 };

  const { data: users } = await supabase
    .from('user_profiles')
    .select('telegram_id, language_code');

  let sentCount = 0;
  for (const user of users || []) {
    try {
      const text = withTagline(message, user.language_code);
      await sendBotMessage(user.telegram_id, text, { parse_mode: 'Markdown' });
      sentCount += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.error(`Failed broadcast ${user.telegram_id}:`, error?.message || error);
    }
  }

  if (scheduledId) {
    await supabase.from('scheduled_notifications').update({
      status: 'sent',
      sent_count: sentCount,
      sent_at: new Date().toISOString(),
    }).eq('id', scheduledId);
  }

  return { sentCount, totalUsers: (users || []).length };
}
