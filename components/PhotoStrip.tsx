import Image from 'next/image';

const PHOTOS = [
  { src: '/img/yellow-trotro.jpg', caption: "Driver's view" },
  { src: '/img/trotro-two.jpg', caption: 'Kaneshie traffic' },
  { src: '/img/makola-movements-one.jpg', caption: 'Makola market' },
  { src: '/img/trotro-mate-in-trotro.jpg', caption: 'Calling the stops' },
  { src: '/img/jamestown-lighthouse.jpg', caption: 'Jamestown lighthouse' },
  { src: '/img/sky-scrapper-on-accra-street-one.jpg', caption: 'Ridge towers' },
  { src: '/img/makola-movements-two.jpg', caption: 'Makola market' },
  { src: '/img/mate-in-red-trotro.jpg', caption: 'Red trotro mate' },
  { src: '/img/sky-scrapper-on-accra-street-two.jpg', caption: 'City heights' },
  { src: '/img/achomta-school-image-one.jpg', caption: 'Achimota school' },
  { src: '/img/makola-movements-three.jpg', caption: 'Makola market' },
  { src: '/img/ecobank-headquarters-building-one.jpg', caption: 'Castle Road' },
  { src: '/img/james-town-lighthouse-1960s.jpg', caption: 'Jamestown, 1960s' },
  { src: '/img/makola-movements-four.jpg', caption: 'Makola market' },
  { src: '/img/ecobank-headquarters-building-two.jpg', caption: 'Accra skyline' },
  { src: '/img/mate-in-yellow-trotro.jpg', caption: 'Yellow TroTro mate' },
  { src: '/img/tema-motor-way-trotro-two.jpg', caption: 'Tema Motorway' },
  { src: '/img/makola-movements-five.jpg', caption: 'Makola market' },
  { src: '/img/mel-construction-bridge.jpg', caption: 'Bridge works' },
  { src: '/img/trotro-mate-in-trotro-two.jpg', caption: 'On the road' },
  { src: '/img/achomta-school-image-two.jpg', caption: 'Achimota school' },
  { src: '/img/makola-movements-six.jpg', caption: 'Makola market' },
  { src: '/img/tema-motor-way-trotro-one.jpg', caption: 'Tema Motorway' },
  { src: '/img/trotro-one.jpg', caption: 'Mate at work' },
];

export function PhotoStrip() {
  
  const reel = [...PHOTOS, ...PHOTOS];

  return (
    <div className="tg-photostrip-wrap">
      <p className="tg-pilllabel">Accra, in motion</p>
      <div className="tg-photostrip" aria-label="Photos of Accra and its trotros">
        <ul className="tg-photostrip-track">
          {reel.map((p, i) => (
            <li className="tg-photocard" key={i} aria-hidden={i >= PHOTOS.length}>
              <div className="tg-photocard-img">
                <Image src={p.src} alt={i < PHOTOS.length ? p.caption : ''} fill sizes="138px" loading="lazy" />
              </div>
              <p className="tg-photocard-cap">{p.caption}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
