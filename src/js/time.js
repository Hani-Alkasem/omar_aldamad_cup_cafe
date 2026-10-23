// Times the way people say them in Daraa ("٨ الصبح", "١١ بالليل") and in casual English ("8am").
// Shared by the build (static hours) and the browser (open-now line).

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arabicDigits = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[d]);

export function spokenTime(hhmm, lang) {
  if (hhmm === '23:59') return lang === 'ar' ? 'نص الليل' : 'midnight';
  const [h, m] = hhmm.split(':').map(Number);
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  if (lang !== 'ar') return `${clock}${h < 12 ? 'am' : 'pm'}`;
  const part = h < 4 ? 'بالليل' : h < 12 ? 'الصبح' : h < 15 ? 'الظهر' : h < 18 ? 'العصر' : h < 21 ? 'المسا' : 'بالليل';
  return `${arabicDigits(clock)} ${part}`;
}
