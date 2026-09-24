// Encoded-polyline (Google/Mapbox algorithm), vendored so we don't depend on @mapbox/polyline.

function encodeSigned(num: number): string {
  let sgn = num < 0 ? ~(num << 1) : num << 1;
  let out = '';
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

export function encode(coordinates: [number, number][], precision = 5): string {
  if (coordinates.length === 0) return '';
  const factor = Math.pow(10, precision);
  const round = (v: number) => Math.round(v * factor);

  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  for (const [lat, lng] of coordinates) {
    const rLat = round(lat);
    const rLng = round(lng);
    out += encodeSigned(rLat - prevLat);
    out += encodeSigned(rLng - prevLng);
    prevLat = rLat;
    prevLng = rLng;
  }
  return out;
}

export function decode(str: string, precision = 5): [number, number][] {
  const factor = Math.pow(10, precision);
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < str.length) {
    let shift = 1;
    let result = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result += (byte & 0x1f) * shift;
      shift *= 32;
    } while (byte >= 0x20);
    lat += result & 1 ? (-result - 1) / 2 : result / 2;

    shift = 1;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result += (byte & 0x1f) * shift;
      shift *= 32;
    } while (byte >= 0x20);
    lng += result & 1 ? (-result - 1) / 2 : result / 2;

    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}
