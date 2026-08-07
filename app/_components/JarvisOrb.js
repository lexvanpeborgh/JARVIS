'use client';

export default function JarvisOrb({ active = false, compact = false, status = 'READY', onClick }) {
  return (
    <button
      className={`jarvisOrb ${active ? 'isActive' : ''} ${compact ? 'isCompact' : ''}`}
      onClick={onClick}
      type="button"
      aria-label="Start JARVIS Live"
    >
      <span className="orbAtmosphere" />
      <span className="orbRing orbRingOne"><i /><i /><i /></span>
      <span className="orbRing orbRingTwo"><i /><i /></span>
      <span className="orbRing orbRingThree" />
      <span className="orbAxis orbAxisOne" />
      <span className="orbAxis orbAxisTwo" />
      <span className="orbPlanet">
        <span className="planetCloud cloudOne" />
        <span className="planetCloud cloudTwo" />
        <span className="planetGlow" />
        <span className="orbLabel">J</span>
      </span>
      <span className="orbReadout">{status}</span>
    </button>
  );
}
