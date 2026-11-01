/** Explicitly labelled geometric placeholder shown until the owner imports their character PNG. */
export function Placeholder() {
  return (
    <svg className="placeholder" viewBox="0 0 200 240" role="img" aria-label="Placeholder character — import your image in Setup">
      <defs>
        <linearGradient id="ph-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a2a31" />
          <stop offset="1" stopColor="#111115" />
        </linearGradient>
      </defs>
      <path d="M100 10 L150 40 L172 96 L150 168 L100 210 L50 168 L28 96 L50 40 Z" fill="url(#ph-metal)" stroke="var(--gold)" strokeWidth="3" />
      <path d="M100 30 L118 70 L100 150 L82 70 Z" fill="none" stroke="var(--gold)" strokeWidth="2" opacity="0.85" />
      <path d="M58 92 L88 100 L60 108 Z" fill="var(--violet)" />
      <path d="M142 92 L112 100 L140 108 Z" fill="var(--violet)" />
      <path d="M100 150 L112 170 L100 196 L88 170 Z" fill="var(--gold)" opacity="0.9" />
      <text x="100" y="232" textAnchor="middle" fontSize="13" fill="#e8e3d4" fontFamily="system-ui, sans-serif" letterSpacing="1">
        PLACEHOLDER
      </text>
    </svg>
  );
}
