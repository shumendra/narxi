export const CITY_OPTIONS = [
  {
    value: 'Tashkent',
    labels: { uz: 'Toshkent', ru: 'Ташкент', en: 'Tashkent' },
    center: [41.2995, 69.2401],
    zoom: 12,
    aliases: ['tashkent', 'toshkent', 'toshkent sh', 'toshkent shahri', 'toshkent sh.', 'ташкент', 'город ташкент'],
  },
  {
    value: 'Samarkand',
    labels: { uz: 'Samarqand', ru: 'Самарканд', en: 'Samarkand' },
    center: [39.6542, 66.9597],
    zoom: 12,
    aliases: ['samarkand', 'samarqand', 'самарканд'],
  },
  {
    value: 'Bukhara',
    labels: { uz: 'Buxoro', ru: 'Бухара', en: 'Bukhara' },
    center: [39.7747, 64.4286],
    zoom: 12,
    aliases: ['bukhara', 'buxoro', 'бухара'],
  },
  {
    value: 'Andijan',
    labels: { uz: 'Andijon', ru: 'Андижан', en: 'Andijan' },
    center: [40.7821, 72.3442],
    zoom: 12,
    aliases: ['andijan', 'andijon', 'андижан'],
  },
  {
    value: 'Fergana',
    labels: { uz: 'Fargʻona', ru: 'Фергана', en: 'Fergana' },
    center: [40.3864, 71.7864],
    zoom: 12,
    aliases: ['fergana', 'fargona', 'fargʻona', 'фаргана', 'фергана'],
  },
  {
    value: 'Namangan',
    labels: { uz: 'Namangan', ru: 'Наманган', en: 'Namangan' },
    center: [40.9983, 71.6726],
    zoom: 12,
    aliases: ['namangan', 'наманган'],
  },
  {
    value: 'Nukus',
    labels: { uz: 'Nukus', ru: 'Нукус', en: 'Nukus' },
    center: [42.4602, 59.6166],
    zoom: 12,
    aliases: ['nukus', 'нукус'],
  },
  {
    value: 'Qarshi',
    labels: { uz: 'Qarshi', ru: 'Карши', en: 'Qarshi' },
    center: [38.8606, 65.7891],
    zoom: 12,
    aliases: ['qarshi', 'karshi', 'карши'],
  },
  {
    value: 'Termez',
    labels: { uz: 'Termiz', ru: 'Термез', en: 'Termez' },
    center: [37.2242, 67.2783],
    zoom: 12,
    aliases: ['termez', 'termiz', 'термез', 'термиз'],
  },
  {
    value: 'Gulistan',
    labels: { uz: 'Guliston', ru: 'Гулистан', en: 'Gulistan' },
    center: [40.4897, 68.7842],
    zoom: 12,
    aliases: ['gulistan', 'guliston', 'гулистан'],
  },
  {
    value: 'Jizzakh',
    labels: { uz: 'Jizzax', ru: 'Джизак', en: 'Jizzakh' },
    center: [40.1158, 67.8422],
    zoom: 12,
    aliases: ['jizzakh', 'jizzax', 'джизак', 'джиззах'],
  },
  {
    value: 'Navoiy',
    labels: { uz: 'Navoiy', ru: 'Навои', en: 'Navoiy' },
    center: [40.1039, 65.3688],
    zoom: 12,
    aliases: ['navoiy', 'navoi', 'навои'],
  },
  {
    value: 'Urgench',
    labels: { uz: 'Urganch', ru: 'Ургенч', en: 'Urgench' },
    center: [41.5534, 60.6317],
    zoom: 12,
    aliases: ['urgench', 'urganch', 'ургенч', 'урганч'],
  },
  {
    value: 'Kokand',
    labels: { uz: 'Qoʻqon', ru: 'Коканд', en: 'Kokand' },
    center: [40.5286, 70.9425],
    zoom: 12,
    aliases: ['kokand', 'qoqon', 'qoʻqon', 'қўқон', 'коканд'],
  },
  {
    value: 'Margilan',
    labels: { uz: 'Margʻilon', ru: 'Маргилан', en: 'Margilan' },
    center: [40.4722, 71.7246],
    zoom: 12,
    aliases: ['margilan', 'margilon', 'margʻilon', 'маргилан'],
  },
  {
    value: 'Chirchiq',
    labels: { uz: 'Chirchiq', ru: 'Чирчик', en: 'Chirchiq' },
    center: [41.4689, 69.5822],
    zoom: 12,
    aliases: ['chirchiq', 'chirchik', 'чирчик'],
  },
  {
    value: 'Angren',
    labels: { uz: 'Angren', ru: 'Ангрен', en: 'Angren' },
    center: [41.0167, 70.1436],
    zoom: 12,
    aliases: ['angren', 'ангрен'],
  },
  {
    value: 'Bekabad',
    labels: { uz: 'Bekobod', ru: 'Бекабад', en: 'Bekabad' },
    center: [40.2208, 69.2697],
    zoom: 12,
    aliases: ['bekabad', 'bekobod', 'бекабад'],
  },
];

export const DEFAULT_CITY = 'Tashkent';

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[ʻ’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getCityOption(cityName = DEFAULT_CITY) {
  return CITY_OPTIONS.find(city => city.value === cityName) || CITY_OPTIONS[0];
}

export function getCityLabel(cityName = DEFAULT_CITY, lang = 'uz') {
  return getCityOption(cityName)?.labels?.[lang] || getCityOption(cityName)?.labels?.uz || cityName;
}

export function normalizeCityName(value = '') {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return null;

  for (const city of CITY_OPTIONS) {
    const aliases = [city.value, ...(city.aliases || []), city.labels?.uz, city.labels?.ru, city.labels?.en].filter(Boolean);
    if (aliases.some(alias => normalizeText(alias) === normalizedValue)) {
      return city.value;
    }
  }

  return null;
}

export function extractCityFromAddress(address = '') {
  const normalizedAddress = normalizeText(address);
  if (!normalizedAddress) return DEFAULT_CITY;

  const sortedCities = [...CITY_OPTIONS].sort((a, b) => {
    const aLength = Math.max(a.value.length, ...(a.aliases || []).map(alias => alias.length));
    const bLength = Math.max(b.value.length, ...(b.aliases || []).map(alias => alias.length));
    return bLength - aLength;
  });

  for (const city of sortedCities) {
    const aliases = [city.value, ...(city.aliases || []), city.labels?.uz, city.labels?.ru, city.labels?.en].filter(Boolean);
    if (aliases.some(alias => normalizedAddress.includes(normalizeText(alias)))) {
      return city.value;
    }
  }

  return DEFAULT_CITY;
}
