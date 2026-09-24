import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP, DrawSVGPlugin);

// An architect's elevation drawing (pavilion, grid axes, dimensions, north arrow, a tree and a
// person for scale) that draws itself line by line with GSAP. Purely decorative.
// `delay` in seconds; `onDrawn` fires when the last line is finished.
export default function Blueprint({ className = '', delay = 0, duration = 1.6, onDrawn }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // Explicit end values, then inline styles cleared, so every line ends fully drawn.
        gsap
          .timeline({ delay, onComplete: onDrawn, defaults: { lazy: false } })
          .fromTo(
            '.bp-line',
            { drawSVG: '0%' },
            { drawSVG: '100%', duration, ease: 'power2.inOut', stagger: duration / 40, clearProps: 'strokeDasharray,strokeDashoffset' },
          )
          .fromTo('.bp-fade', { opacity: 0 }, { opacity: 1, duration: 0.6, stagger: 0.05, clearProps: 'opacity' }, `-=${duration * 0.45}`)
          .fromTo('.bp-glass', { opacity: 0 }, { opacity: 1, duration: 0.8, clearProps: 'opacity' }, '<');
      });
      mm.add('(prefers-reduced-motion: reduce)', () => onDrawn?.());
      return () => mm.revert();
    },
    { scope: ref },
  );

  return (
    <svg ref={ref} className={`blueprint ${className}`} viewBox="0 0 480 300" fill="none" aria-hidden="true" focusable="false">
      {/* Grid axes and bubbles */}
      <g className="bp-fade bp-axis">
        <path d="M110 84V262M220 84V262M330 84V262" />
      </g>
      <g className="bp-fade bp-label">
        <circle cx="110" cy="272" r="9" />
        <circle cx="220" cy="272" r="9" />
        <circle cx="330" cy="272" r="9" />
        <text x="110" y="276">A</text>
        <text x="220" y="276">B</text>
        <text x="330" y="276">C</text>
      </g>

      {/* Glazing tint (under the lines) */}
      <g className="bp-glass">
        <path d="M111 171H329V240H111Z" />
        <path d="M113 121H281V143H113Z" />
      </g>

      {/* Ground and plinth */}
      <path className="bp-line bp-strong" d="M16 250H464" />
      <path className="bp-line" d="M60 250V241H420V250" />

      {/* Tree */}
      <circle className="bp-line" cx="40" cy="198" r="24" />
      <circle className="bp-line" cx="52" cy="210" r="14" />
      <path className="bp-line" d="M40 222V250" />

      {/* Ground floor glass box */}
      <path className="bp-line" d="M110 241V170H330V241" />
      <path className="bp-line bp-thin" d="M110 182H330M165 170V241M220 170V241M275 170V241" />

      {/* Cantilevered first-floor slab, upper volume and ribbon window */}
      <path className="bp-line bp-strong" d="M70 170H402V161H70Z" />
      <path className="bp-line" d="M92 161V104H302V161" />
      <path className="bp-line" d="M112 120H282V144H112Z" />
      <path className="bp-line bp-thin" d="M154 120V144M197 120V144M240 120V144" />

      {/* Roof slab and pilotis */}
      <path className="bp-line bp-strong" d="M80 104H322V96H80Z" />
      <path className="bp-line" d="M384 170V241M394 170V241" />

      {/* Entry steps */}
      <path className="bp-line bp-thin" d="M330 241H342V235H352V229H362" />

      {/* Person for scale, arriving at the entrance */}
      <circle className="bp-line" cx="414" cy="213" r="4" />
      <path className="bp-line" d="M414 217V233M414 233L409 250M414 233L419 250M407 223H421" />

      {/* Dimensions */}
      <path className="bp-line bp-thin" d="M80 72H322M80 66V78M322 66V78" />
      <path className="bp-line bp-thin" d="M440 96V250M434 96H446M434 250H446" />
      <g className="bp-fade bp-label">
        <text x="201" y="64">24 200</text>
        <text x="452" y="176" transform="rotate(-90 452 176)">
          15 400
        </text>
      </g>

      {/* North arrow */}
      <circle className="bp-line bp-thin" cx="440" cy="40" r="13" />
      <path className="bp-line" d="M440 29L445 46L440 42L435 46Z" />
      <text className="bp-fade bp-label" x="440" y="22">
        N
      </text>
    </svg>
  );
}
