export const TASHKENT_DISTRICTS = {
  'chilonzor': { lat: 41.2825, lng: 69.2068, name: 'Chilonzor' },
  'yunusabad': { lat: 41.3661, lng: 69.3231, name: 'Yunusabad' },
  'mirzo ulugbek': { lat: 41.3308, lng: 69.3667, name: "Mirzo Ulug'bek" },
  'sergeli': { lat: 41.2156, lng: 69.2456, name: 'Sergeli' },
  'shayxontohur': { lat: 41.3100, lng: 69.2900, name: 'Shayxontohur' },
  'olmazor': { lat: 41.3356, lng: 69.2156, name: 'Olmazor' },
  'uchtepa': { lat: 41.3089, lng: 69.2089, name: 'Uchtepa' },
  'yakkasaroy': { lat: 41.2894, lng: 69.2756, name: 'Yakkasaroy' },
  'mirobod': { lat: 41.2989, lng: 69.3100, name: 'Mirobod' },
  'bektemir': { lat: 41.2489, lng: 69.3567, name: 'Bektemir' },
  'yashnobod': { lat: 41.2656, lng: 69.3231, name: 'Yashnobod' },
  'zangiota': { lat: 41.1989, lng: 69.2689, name: 'Zangiota' },
};

export const DISTRICT_LIST = Object.entries(TASHKENT_DISTRICTS).map(
  ([key, val]) => ({ key, ...val })
);

export function findDistrict(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase().replace(/['ʻʼ]/g, '');
  return DISTRICT_LIST.filter(d =>
    d.key.includes(q) || d.name.toLowerCase().replace(/['ʻʼ]/g, '').includes(q)
  );
}
